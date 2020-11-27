/* eslint-disable prefer-destructuring */
import assert from 'assert';
import { PassThrough } from 'stream';
import { resolve } from 'path';
import os from 'os';
import http from 'http';
import moment from 'moment-timezone';
import { isSafeInteger, Dictionary, filter } from 'lodash';
import { ObjectID } from 'mongodb';
import Koa, { Context } from 'koa';
import Body from 'koa-body';
import Router from 'koa-router';
import cache from 'koa-static-cache';
import sockjs from 'sockjs';
import { SetOption } from 'cookies';
import serialize, { SerializeJSOptions } from 'serialize-javascript';
import { argv } from 'yargs';
import { lrucache } from '../utils';
import { User, DomainDoc } from '../interface';
import { Logger } from '../logger';
import {
    UserNotFoundError, BlacklistedError, PermissionError,
    UserFacingError, ValidationError, PrivilegeError,
    CsrfTokenError, InvalidOperationError, MethodNotAllowedError,
    NotFoundError, HydroError,
} from '../error';
import hash from '../lib/hash.hydro';
import * as misc from '../lib/misc';
import * as user from '../model/user';
import * as domain from '../model/domain';
import * as system from '../model/system';
import * as blacklist from '../model/blacklist';
import * as token from '../model/token';
import * as opcount from '../model/opcount';
import { PERM } from '../model/builtin';

const logger = new Logger('server');
export const app = new Koa();
export const server = http.createServer(app.callback());
export const router = new Router();

type MethodDecorator = (target: any, name: string, obj: any) => any;
type Converter = (value: any) => any;
type Validator = (value: any) => boolean;
interface ParamOption {
    name: string,
    source: 'all' | 'get' | 'post' | 'route',
    isOptional?: boolean,
    convert?: Converter,
    validate?: Validator,
}

type Type = [Converter, Validator, boolean?];

export interface Types {
    String: Type,
    Int: Type,
    UnsignedInt: Type,
    PositiveInt: Type,
    Float: Type,
    ObjectID: Type,
    Boolean: Type,
    Date: Type,
    Time: Type,
    Range: (range: Array<string | number> | Dictionary<any>) => Type,
    Array: Type,
}

export const Types: Types = {
    String: [(v) => v.toString(), null],
    Int: [(v) => parseInt(v, 10), (v) => isSafeInteger(parseInt(v, 10))],
    UnsignedInt: [(v) => parseInt(v, 10), (v) => parseInt(v, 10) >= 0],
    PositiveInt: [(v) => parseInt(v, 10), (v) => parseInt(v, 10) > 0],
    Float: [(v) => parseFloat(v), (v) => {
        const t = parseFloat(v);
        return t && !Number.isNaN(t) && Number.isFinite(t);
    }],
    // eslint-disable-next-line no-shadow
    ObjectID: [(v) => new ObjectID(v), ObjectID.isValid],
    Boolean: [(v) => !!v, null, true],
    Date: [
        (v) => {
            const d = v.split('-');
            assert(d.length === 3);
            return `${d[0]}-${d[1].length === 1 ? '0' : ''}${d[1]}-${d[2].length === 1 ? '0' : ''}${d[2]}`;
        },
        (v) => {
            const d = v.split('-');
            assert(d.length === 3);
            const st = `${d[0]}-${d[1].length === 1 ? '0' : ''}${d[1]}-${d[2].length === 1 ? '0' : ''}${d[2]}`;
            return moment(st).isValid();
        },
    ],
    Time: [
        (v) => {
            const t = v.split(':');
            assert(t.length === 2);
            return `${(t[0].length === 1 ? '0' : '') + t[0]}:${t[1].length === 1 ? '0' : ''}${t[1]}`;
        },
        (v) => {
            const t = v.split(':');
            assert(t.length === 2);
            return moment(`2020-01-01 ${(t[0].length === 1 ? '0' : '') + t[0]}:${t[1].length === 1 ? '0' : ''}${t[1]}`).isValid();
        },
    ],
    Range: (range) => [
        (v) => {
            if (range instanceof Array) {
                for (const item of range) {
                    if (typeof item === 'number') {
                        if (item === parseInt(v, 10)) return parseInt(v, 10);
                    } else if (item === v) return v;
                }
            }
            return v;
        },
        (v) => {
            if (range instanceof Array) {
                for (const item of range) {
                    if (typeof item === 'string') {
                        if (item === v) return true;
                    } else if (typeof item === 'number') {
                        if (item === parseInt(v, 10)) return true;
                    }
                }
            } else {
                for (const key in range) {
                    if (key === v) return true;
                }
            }
            return false;
        },
    ],
    Array: [(v) => {
        if (v instanceof Array) return v;
        return [v] || [];
    }, null],
};

function _buildParam(name: string, source: 'get' | 'post' | 'all' | 'route', ...args: Array<Type | boolean | Validator | Converter>) {
    let cursor = 0;
    const v: ParamOption = { name, source };
    let isValidate = true;
    while (cursor < args.length) {
        const current = args[cursor];
        if (current instanceof Array) {
            const type = current;
            if (type[0]) v.convert = type[0];
            if (type[1]) v.validate = type[1];
            if (type[2]) v.isOptional = type[2];
        } else if (typeof current === 'boolean') v.isOptional = current;
        else if (isValidate) {
            if (current !== null) v.validate = current;
            isValidate = false;
        } else v.convert = current;
        cursor++;
    }
    return v;
}

function _descriptor(v: ParamOption) {
    return function desc(this: Handler, target: any, funcName: string, obj: any) {
        if (!target.__param) target.__param = {};
        if (!target.__param[target.constructor.name]) target.__param[target.constructor.name] = {};
        if (!target.__param[target.constructor.name][funcName]) {
            target.__param[target.constructor.name][funcName] = [{ name: 'domainId', type: 'string', source: 'route' }];
            const originalMethod = obj.value;
            obj.value = function validate(this: Handler, rawArgs: any, ...extra: any[]) {
                if (typeof rawArgs !== 'object' || extra.length) return originalMethod.call(this, rawArgs, ...extra);
                const c = [];
                const arglist: ParamOption[] = this.__param[target.constructor.name][funcName];
                for (const item of arglist) {
                    const src = item.source === 'all'
                        ? rawArgs
                        : item.source === 'get'
                            ? this.request.query
                            : item.source === 'route'
                                ? { ...this.request.params, domainId: this.domainId }
                                : this.request.body;
                    const value = src[item.name];
                    if (!item.isOptional || value) {
                        if (!value) throw new ValidationError(item.name);
                        if (item.validate && !item.validate(value)) throw new ValidationError(item.name);
                        if (item.convert) c.push(item.convert(value));
                        else c.push(value);
                    } else c.push(undefined);
                }
                return originalMethod.call(this, ...c);
            };
        }
        target.__param[target.constructor.name][funcName].splice(1, 0, v);
        return obj;
    };
}

export function get(
    name: string, type: Type, validate: null, convert: Converter
): MethodDecorator;
export function get(
    name: string, type: Type, validate?: Validator, convert?: Converter,
): MethodDecorator;
export function get(
    name: string, type?: Type, isOptional?: boolean, validate?: Validator, convert?: Converter,
): MethodDecorator;
export function get(
    name: string, ...args: Array<Type | boolean | Validator | Converter>
): MethodDecorator;
export function get(name: string, ...args: any): MethodDecorator {
    return _descriptor(_buildParam(name, 'get', ...args));
}

export function post(
    name: string, type: Type, validate: null, convert: Converter
): MethodDecorator;
export function post(
    name: string, type?: Type, validate?: Validator, convert?: Converter,
): MethodDecorator;
export function post(
    name: string, type?: Type, isOptional?: boolean, validate?: Validator, convert?: Converter,
): MethodDecorator;
export function post(
    name: string, ...args: Array<Type | boolean | Converter | Validator>
): MethodDecorator;
export function post(name: string, ...args: any): MethodDecorator {
    return _descriptor(_buildParam(name, 'post', ...args));
}

export function route(
    name: string, type: Type, validate: null, convert: Converter
): MethodDecorator;
export function route(
    name: string, type?: Type, validate?: Validator, convert?: Converter,
): MethodDecorator;
export function route(
    name: string, type?: Type, isOptional?: boolean, validate?: Validator, convert?: Converter,
): MethodDecorator;
export function route(
    name: string, ...args: Array<Type | boolean | Converter | Validator>
): MethodDecorator;
export function route(name: string, ...args: any): MethodDecorator {
    return _descriptor(_buildParam(name, 'route', ...args));
}

export function param(
    name: string, type: Type, validate: null, convert: Converter
): MethodDecorator;
export function param(
    name: string, type?: Type, validate?: Validator, convert?: Converter,
): MethodDecorator;
export function param(
    name: string, type?: Type, isOptional?: boolean, validate?: Validator, convert?: Converter,
): MethodDecorator;
export function param(
    name: string, ...args: Array<Type | boolean | Converter | Validator>
): MethodDecorator;
export function param(name: string, ...args: any): MethodDecorator {
    return _descriptor(_buildParam(name, 'all', ...args));
}

export function requireCsrfToken(target: any, funcName: string, obj: any) {
    const originalMethod = obj.value;
    obj.value = async function checkCsrfToken(...args: any[]) {
        if (this.getCsrfToken(this.session._id) !== this.args.csrfToken) {
            throw new CsrfTokenError(this.args.csrfToken);
        }
        return await originalMethod.call(this, ...args);
    };
    return obj;
}

export async function prepare() {
    app.keys = system.get('session.keys') as unknown as string[];
    if (argv.public) {
        app.use(cache(argv.public, {
            maxAge: 0,
        }));
    } else {
        app.use(cache(resolve(os.tmpdir(), 'hydro', 'public'), {
            maxAge: 365 * 24 * 60 * 60,
        }));
    }
    app.use(Body({
        multipart: true,
        formidable: {
            maxFileSize: 256 * 1024 * 1024,
        },
    }));
}

export class Handler {
    UIContext: any;

    args: any;

    domainId: string;

    ctx: Koa.Context;

    request: {
        host: string,
        hostname: string,
        ip: string,
        headers: any,
        cookies: any,
        body: any,
        files: any,
        query: any,
        path: string,
        params: any,
        referer: string,
        json: boolean,
    };

    response: {
        body: any,
        type: string,
        status: number,
        template?: string,
        redirect?: string,
        disposition?: string,
        attachment: (name: string, stream?: any) => void,
    };

    session: any;

    csrfToken: string;

    user: User;

    domain: DomainDoc;

    loginMethods: any;

    __param: Record<string, ParamOption[]>;

    constructor(ctx: Koa.Context) {
        this.ctx = ctx;
        this.request = {
            host: ctx.request.host,
            hostname: ctx.request.hostname,
            ip: ctx.request.ip,
            headers: ctx.request.headers,
            cookies: ctx.cookies,
            // @ts-ignore
            body: ctx.request.body,
            // @ts-ignore
            files: ctx.request.files,
            query: ctx.query,
            path: ctx.path,
            params: ctx.params,
            referer: ctx.request.headers.referer || '/',
            json: (ctx.request.headers.accept || '').includes('application/json'),
        };
        this.response = {
            body: {},
            type: '',
            status: null,
            template: null,
            redirect: null,
            attachment: (name, streamOrBuffer) => {
                ctx.attachment(name);
                if (streamOrBuffer instanceof Buffer) {
                    this.response.body = null;
                    ctx.body = streamOrBuffer;
                } else {
                    this.response.body = null;
                    ctx.body = streamOrBuffer.pipe(new PassThrough());
                }
            },
            disposition: null,
        };
        this.UIContext = {
            cdn_prefix: '/',
            url_prefix: '/',
        };
        this.session = {};
    }

    @lrucache
    // eslint-disable-next-line class-methods-use-this
    getCsrfToken(id: string) {
        return hash('csrf_token', id);
    }

    async renderHTML(name: string, context: any): Promise<string> {
        const UserContext = {
            ...this.user,
            gravatar: misc.gravatar(this.user.gravatar || '', 128),
            perm: this.user.perm.toString(),
        };
        if (!global.Hydro.lib.template) return JSON.stringify(context);
        const res = await global.Hydro.lib.template.render(name, {
            handler: this,
            UserContext,
            url: this.url.bind(this),
            _: this.translate.bind(this),
            ...context,
        });
        return res;
    }

    async limitRate(op: string, periodSecs: number, maxOperations: number) {
        await opcount.inc(op, this.request.ip, periodSecs, maxOperations);
    }

    translate(str: string) {
        if (!str) return '';
        return str.toString().translate(this.user.viewLang, this.session.viewLang);
    }

    renderTitle(str: string) {
        return `${this.translate(str)} - ${system.get('server.name')}`;
    }

    checkPerm(...args: bigint[]) {
        // @ts-ignore
        if (!this.user.hasPerm(...args)) throw new PermissionError(...args);
    }

    checkPriv(...args: number[]) {
        // @ts-ignore
        if (!this.user.hasPriv(...args)) throw new PrivilegeError(...args);
    }

    url(name: string, kwargs: any = {}) {
        let res = '#';
        const args: any = {};
        const query: any = {};
        for (const key in kwargs) {
            if (kwargs[key] instanceof ObjectID) args[key] = kwargs[key].toHexString();
            else args[key] = kwargs[key].toString();
        }
        for (const key in kwargs.query || {}) {
            if (query[key] instanceof ObjectID) query[key] = kwargs.query[key].toHexString();
            else query[key] = kwargs.query[key].toString();
        }
        try {
            if (this.domainId !== 'system' || args.domainId) {
                name += '_with_domainId';
                args.domainId = args.domainId || this.domainId;
            }
            const { anchor } = args;
            res = router.url(name, args, { query });
            if (anchor) return `${res}#${anchor}`;
        } catch (e) {
            console.error(e.message);
            console.log(name, args);
            console.log(e.stack);
        }
        return res;
    }

    async render(name: string, context: any) {
        this.response.body = await this.renderHTML(name, context);
        this.response.type = 'text/html';
    }

    back(body?: any) {
        this.response.body = body || this.response.body || {};
        this.response.redirect = this.request.headers.referer || '/';
    }

    binary(data: any, name: string) {
        this.response.body = data;
        this.response.template = null;
        this.response.type = 'application/octet-stream';
        this.response.disposition = `attachment; filename="${name}"`;
    }

    async getSession() {
        const sid = this.request.cookies.get('sid');
        this.session = await token.get(sid, token.TYPE_SESSION);
        if (!this.session) this.session = { uid: 0 };
    }

    async getBdoc() {
        const bdoc = await blacklist.get(this.request.ip);
        if (bdoc) throw new BlacklistedError(this.request.ip);
    }

    async init({ domainId }) {
        const xff = system.get('server.xff') as string;
        if (xff) this.request.ip = this.request.headers[xff.toLowerCase()];
        [this.domain] = await Promise.all([
            domain.get(domainId),
            this.getSession(),
            this.getBdoc(),
        ]);
        if (!this.domain) {
            this.args.domainId = 'system';
            this.user = await user.getById('system', this.session.uid);
            if (!this.user) this.user = await user.getById('system', 0);
            throw new NotFoundError(domainId);
        }
        this.user = await user.getById(domainId, this.session.uid, this.session.scope);
        if (!this.user) {
            this.session.uid = 0;
            this.session.scope = PERM.PERM_ALL.toString();
            this.user = await user.getById(domainId, this.session.uid, this.session.scope);
        }
        if (this.user._id === 0 && this.session.viewLang) this.user.viewLang = this.session.viewLang;
        this.csrfToken = this.getCsrfToken(this.session._id || String.random(32));
        this.UIContext.csrfToken = this.csrfToken;
        this.loginMethods = filter(Object.keys(global.Hydro.lib), (str) => str.startsWith('oauth_'))
            .map((key) => ({
                id: key.split('_')[1],
                icon: global.Hydro.lib[key].icon,
                text: global.Hydro.lib[key].text,
            }));
    }

    async finish() {
        if (!this.response.body) return;
        try {
            await this.renderBody();
        } catch (error) {
            this.response.status = error instanceof UserFacingError ? error.code : 500;
            if (this.request.json) this.response.body = { error };
            else {
                try {
                    await this.render(error instanceof UserFacingError ? 'error.html' : 'bsod.html', { error });
                } catch (e) {
                    console.error(e);
                    // this.response.body.error = {};
                }
            }
        }
        await this.putResponse();
        await this.saveCookie();
    }

    async renderBody() {
        if (this.response.redirect) {
            this.response.body = this.response.body || {};
            this.response.body.url = this.response.redirect;
        }
        if (this.response.type) return;
        if (
            this.request.json || this.response.redirect
            || this.request.query.noTemplate || !this.response.template) {
            try {
                this.response.body = JSON.stringify(this.response.body);
            } catch (e) {
                const opt: SerializeJSOptions = { ignoreFunction: true };
                if (this.request.query.noTemplate) opt.space = 2;
                this.response.body = serialize(this.response.body, opt);
            }
            this.response.type = 'application/json';
        } else if (this.response.body || this.response.template) {
            const templateName = this.request.query.template || this.response.template;
            if (templateName) {
                this.response.body = this.response.body || {};
                await this.render(templateName, this.response.body);
            }
        }
    }

    async putResponse() {
        if (this.response.disposition) this.ctx.set('Content-Disposition', this.response.disposition);
        if (!this.response.body) return;
        if (this.response.redirect && !this.request.json) {
            this.ctx.response.type = 'application/octet-stream';
            this.ctx.response.status = 302;
            this.ctx.redirect(this.response.redirect);
        } else {
            this.ctx.response.body = this.response.body;
            this.ctx.response.status = this.response.status || 200;
            this.ctx.response.type = this.request.json
                ? 'application/json'
                : this.response.type
                    ? this.response.type
                    : this.ctx.response.type;
        }
    }

    async saveCookie() {
        const expireSeconds = this.session.save
            ? system.get('session.expire_seconds') as number
            : system.get('session.unsaved_expire_seconds') as number;
        if (this.session._id) {
            await token.update(
                this.session._id,
                token.TYPE_SESSION,
                expireSeconds,
                {
                    ...this.session,
                    updateIp: this.request.ip,
                    updateUa: this.request.headers['user-agent'] || '',
                },
            );
        } else {
            [, this.session] = await token.add(
                token.TYPE_SESSION,
                expireSeconds,
                {
                    ...this.session,
                    createIp: this.request.ip,
                    createUa: this.request.headers['user-agent'] || '',
                    updateIp: this.request.ip,
                    updateUa: this.request.headers['user-agent'] || '',
                },
            );
        }
        const cookie: SetOption = {
            secure: !!system.get('session.secure'),
            httpOnly: false,
        };
        if (this.session.save) {
            cookie.expires = this.session.expireAt;
            cookie.maxAge = expireSeconds;
        }
        this.ctx.cookies.set('sid', this.session._id, cookie);
    }

    async onerror(error: HydroError) {
        if (!error.msg) error.msg = () => error.message;
        console.error(error.msg(), error.params);
        console.error(error.stack);
        this.response.status = error instanceof UserFacingError ? error.code : 500;
        this.response.template = error instanceof UserFacingError ? 'error.html' : 'bsod.html';
        this.response.body = {
            error: { message: error.msg(), params: error.params, stack: error.stack },
        };
        await this.finish().catch(() => { });
    }
}

async function handle(ctx, HandlerClass, checker) {
    global.Hydro.stat.reqCount++;
    const args = {
        domainId: 'system', ...ctx.params, ...ctx.query, ...ctx.request.body,
    };
    const h = new HandlerClass(ctx);
    h.args = args;
    h.domainId = args.domainId;
    try {
        const method = ctx.method.toLowerCase();
        let operation: string;
        if (method === 'post' && ctx.request.body.operation) {
            operation = `_${ctx.request.body.operation}`
                .replace(/_([a-z])/gm, (s) => s[1].toUpperCase());
        }

        await h.init(args);
        if (checker) checker.call(h);
        if (method === 'post') {
            if (operation) {
                if (typeof h[`post${operation}`] !== 'function') {
                    throw new InvalidOperationError(operation);
                }
            } else if (typeof h.post !== 'function') {
                throw new MethodNotAllowedError(method);
            }
        } else if (typeof h[method] !== 'function' && typeof h.all !== 'function') {
            throw new MethodNotAllowedError(method);
        }

        if (h._prepare) await h._prepare(args);
        if (h.prepare) await h.prepare(args);

        if (h[method]) await h[method](args);
        if (operation) await h[`post${operation}`](args);

        if (h.cleanup) await h.cleanup(args);
        if (h.finish) await h.finish(args);
    } catch (e) {
        try {
            await h.onerror(e);
        } catch (err) {
            h.response.code = 500;
            h.response.body = `${err.message}\n${err.stack}`;
        }
    }
}

const Checker = (permPrivChecker) => {
    let perm: bigint;
    let priv: number;
    let checker = () => { };
    for (const item of permPrivChecker) {
        if (typeof item === 'object') {
            if (typeof item.call !== 'undefined') {
                checker = item;
            } else if (typeof item[0] === 'number') {
                priv = item;
            } else if (typeof item[0] === 'bigint') {
                perm = item;
            }
        } else if (typeof item === 'number') {
            priv = item;
        } else if (typeof item === 'bigint') {
            perm = item;
        }
    }
    return function check() {
        checker();
        if (perm) this.checkPerm(perm);
        if (priv) this.checkPriv(priv);
    };
};

export function Route(name: string, path: string, RouteHandler: any, ...permPrivChecker) {
    const checker = Checker(permPrivChecker);
    router.all(name, path, (ctx) => handle(ctx, RouteHandler, checker));
    router.all(`${name}_with_domainId`, `/d/:domainId${path}`, (ctx) => handle(ctx, RouteHandler, checker));
}

export class ConnectionHandler {
    conn: sockjs.Connection;

    request: {
        params: any;
        headers: any;
        ip: string;
    }

    domainId: string;

    session: any;

    args: any;

    user: User;

    domain: DomainDoc;

    constructor(conn: sockjs.Connection) {
        this.conn = conn;
        this.request = {
            params: {},
            headers: conn.headers,
            ip: this.conn.remoteAddress,
        };
        this.session = {};
        const p: any = (conn.url.split('?')[1] || '').split('&');
        for (const i in p) p[i] = p[i].split('=');
        for (const i in p) this.request.params[p[i][0]] = decodeURIComponent(p[i][1]);
    }

    async renderHTML(name: string, context: any): Promise<string> {
        const res = await global.Hydro.lib.template.render(name, Object.assign(context, {
            handler: this,
            url: this.url.bind(this),
            _: this.translate.bind(this),
        }));
        return res;
    }

    async limitRate(op: string, periodSecs: number, maxOperations: number) {
        await opcount.inc(op, this.request.ip, periodSecs, maxOperations);
    }

    translate(str: string) {
        return str ? str.toString().translate(this.user.viewLang || this.session.viewLang) : '';
    }

    renderTitle(str: string) {
        return `${this.translate(str)} - ${system.get('server.name')}`;
    }

    checkPerm(...args: bigint[]) {
        if (!this.user.hasPerm(...args)) throw new PermissionError(...args);
    }

    checkPriv(...args: number[]) {
        // @ts-ignore
        if (!this.user.hasPriv(...args)) throw new PrivilegeError(...args);
    }

    url(name: string, kwargs: any = {}) {
        let res = '#';
        const args: any = {};
        const query: any = {};
        for (const key in kwargs) {
            if (kwargs[key] instanceof ObjectID) args[key] = kwargs[key].toHexString();
            else args[key] = kwargs[key].toString();
        }
        for (const key in kwargs.query || {}) {
            if (query[key] instanceof ObjectID) query[key] = kwargs.query[key].toHexString();
            else query[key] = kwargs.query[key].toString();
        }
        try {
            if (this.args.domainId !== 'system' || args.domainId) {
                name += '_with_domainId';
                args.domainId = args.domainId || this.args.domainId;
            }
            const { anchor } = args;
            res = router.url(name, args, { query });
            if (anchor) return `${res}#${anchor}`;
        } catch (e) {
            console.error(e.message);
            console.log(name, args);
        }
        return res;
    }

    send(data: any) {
        this.conn.write(JSON.stringify(data));
    }

    close(code: number, reason: string) {
        this.conn.close(code.toString(), reason);
    }

    async message(message: any) { } // eslint-disable-line

    onerror(err: HydroError) {
        console.error(err);
        this.send({
            error: {
                name: err.name,
                params: err.params || [],
            },
        });
        this.close(1001, err.toString());
    }

    async getSession(cookieHeader: string) {
        const cookies: any = {};
        const ref = cookieHeader.split(';');
        for (let j = 0; j < ref.length; j++) {
            const cookie = ref[j];
            const parts = cookie.split('=');
            cookies[parts[0].trim()] = (parts[1] || '').trim();
        }
        this.session = await token.get(cookies.sid || '', token.TYPE_SESSION);
        if (!this.session) this.session = { uid: 0, domainId: 'system' };
    }

    @param('cookie', Types.String)
    async init(domainId: string, cookie: string) {
        [this.domain] = await Promise.all([
            domain.get(domainId),
            this.getSession(cookie),
        ]);
        const bdoc = await blacklist.get(this.request.ip);
        if (bdoc) throw new BlacklistedError(this.request.ip);
        this.user = await user.getById(domainId, this.session.uid, this.session.scope);
        if (!this.user) throw new UserNotFoundError(this.session.uid);
        if (this.user._id === 0 && this.session.viewLang) this.user.viewLang = this.session.viewLang;
    }
}

export function Connection(
    name: string, prefix: string,
    RouteConnHandler: any,
    ...permPrivChecker: Array<number | bigint | Function>
) {
    const log = (v: string, fmt: string, ...args: any[]) => logger.debug(fmt, ...args);
    const sock = sockjs.createServer({ prefix, log });
    const checker = Checker(permPrivChecker);
    sock.on('connection', async (conn) => {
        const h: Dictionary<any> = new RouteConnHandler(conn);
        try {
            const args = { domainId: 'system', ...h.request.params };
            h.args = args;
            h.domainId = args.domainId;
            const cookie = await new Promise((r) => {
                conn.once('data', r);
            });
            args.cookie = cookie;
            await h.init(args);
            conn.write(JSON.stringify({ event: 'auth' }));
            checker.call(h);

            if (h._prepare) await h._prepare(args);
            if (h.prepare) await h.prepare(args);
            if (h.message) {
                conn.on('data', (data) => {
                    h.message(JSON.parse(data));
                });
            }
            conn.on('close', async () => {
                if (h.cleanup) await h.cleanup(args);
                if (h.finish) await h.finish(args);
            });
        } catch (e) {
            logger.warn(e);
            await h.onerror(e);
        }
    });
    sock.installHandlers(server);
}

// TODO use postInit?
export function start() {
    const port = system.get('server.port');
    if (argv.debug) {
        app.use(async (ctx: Context, next: Function) => {
            const startTime = new Date().getTime();
            await next();
            const endTime = new Date().getTime();
            if (ctx.response.headers.nolog) return;
            ctx._remoteAddress = ctx.request.ip;
            const status = ctx.response.status;
            const color = status >= 500 ? 31 // red
                : status >= 400 ? 33 // yellow
                    : status >= 300 ? 36 // cyan
                        : status >= 200 ? 32 // green
                            : 0; // no color
            logger.debug(`\
\x1b[0m${ctx.request.method} ${ctx.request.path} \x1b[${color}m${ctx.response.status}\x1b[0m ${endTime - startTime}ms ${ctx.response.length}\x1b[0m`);
        });
    }
    app.use(async (ctx, next) => {
        const xff = system.get('server.xff');
        const ip = xff ? ctx.request.headers[xff] : ctx.request.ip;
        try {
            await opcount.inc('global', ip, 10, 100);
        } catch (e) {
            ctx.status = 429;
            return null;
        }
        return await next();
    });
    app.use(router.routes()).use(router.allowedMethods());
    server.listen(argv.port || port);
    logger.success('Server listening at: %d', argv.port || port);
}

global.Hydro.service.server = {
    Types,
    app,
    server,
    router,
    get,
    post,
    route,
    param,
    requireCsrfToken,
    Handler,
    ConnectionHandler,
    Route,
    Connection,
    prepare,
    start,
};
