import { ObjectID } from 'mongodb';
import { isSafeInteger } from 'lodash';
import { DiscussionNotFoundError, DocumentNotFoundError, PermissionError } from '../error';
import {
    Mdoc, Drdoc, Ddoc, Drrdoc,
} from '../interface';
import paginate from '../lib/paginate';
import * as user from '../model/user';
import * as oplog from '../model/oplog';
import * as message from '../model/message';
import * as discussion from '../model/discussion';
import * as document from '../model/document';
import { PERM, PRIV, CONSTANT } from '../model/builtin';
import {
    Route, Handler, Types, param,
} from '../service/server';
import { isTitle, isContent } from '../lib/validator';

export const typeMapper = {
    problem: document.TYPE_PROBLEM,
    contest: document.TYPE_CONTEST,
    node: document.TYPE_DISCUSSION_NODE,
    training: document.TYPE_TRAINING,
    homework: document.TYPE_HOMEWORK,
};

class DiscussionHandler extends Handler {
    ddoc?: Ddoc;

    drdoc?: Drdoc;

    drrdoc?: Drrdoc;

    vnode?: any;

    @param('type', Types.String, true)
    @param('name', Types.String, true)
    @param('did', Types.ObjectID, true)
    @param('drid', Types.ObjectID, true)
    @param('drrid', Types.ObjectID, true)
    async _prepare(
        domainId: string, type: string, name: string,
        did: ObjectID, drid: ObjectID, drrid: ObjectID,
    ) {
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        if (did) {
            this.ddoc = await discussion.get(domainId, did);
            if (!this.ddoc) throw new DiscussionNotFoundError(did);
            type = discussion.typeDisplay[this.ddoc.parentType];
            name = this.ddoc.parentId.toString();
            if (drrid) {
                [this.drdoc, this.drrdoc] = await discussion.getTailReply(domainId, drid, drrid);
                if (!this.drrdoc) throw new DiscussionNotFoundError(drrid);
            } else if (drid) {
                this.drdoc = await discussion.getReply(domainId, drid);
                if (!this.drdoc) throw new DiscussionNotFoundError(drid);
                if (!this.drdoc.parentId.equals(this.ddoc._id)) {
                    throw new DocumentNotFoundError(drid);
                }
            }
        }
        // TODO(twd2): do more visibility check eg. contest
        // TODO(twd2): exclude problem/contest discussions?
        // TODO(iceboy): continuation based pagination.
        this.vnode = await discussion.getVnode(domainId, typeMapper[type], name);
        if (this.vnode.hidden) this.checkPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN);
        if (this.ddoc) {
            this.ddoc.parentType = this.ddoc.parentType || this.vnode.type;
            this.ddoc.parentId = this.ddoc.parentId || this.vnode.id;
        }
    }
}

class DiscussionMainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const [ddocs, dpcount] = await paginate(
            discussion.getMulti(domainId),
            page,
            CONSTANT.DISCUSSION_PER_PAGE,
        );
        const udict = await user.getList(domainId, ddocs.map((ddoc) => ddoc.owner));
        const path = [
            ['Hydro', 'homepage'],
            ['discussion_main', null],
        ];
        const [vndict, vnodes] = await Promise.all([
            discussion.getListVnodes(
                domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN),
            ),
            discussion.getNodes(domainId),
        ]);
        this.response.template = 'discussion_main_or_node.html';
        this.response.body = {
            ddocs, dpcount, udict, page, page_name: 'discussion_main', vndict, vnode: {}, path, vnodes,
        };
    }
}

class DiscussionNodeHandler extends DiscussionHandler {
    @param('type', Types.String)
    @param('name', Types.String)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, type: string, _name: string, page = 1) {
        let name: ObjectID | string | number;
        if (ObjectID.isValid(_name)) name = new ObjectID(_name);
        else if (isSafeInteger(parseInt(_name, 10))) name = parseInt(_name, 10);
        else name = _name;
        const [ddocs, dpcount] = await paginate(
            discussion.getMulti(domainId, { parentType: typeMapper[type], parentId: name }),
            page,
            CONSTANT.DISCUSSION_PER_PAGE,
        );
        const uids = ddocs.map((ddoc) => ddoc.owner);
        uids.push(this.vnode.owner);
        const [udict, vnodes] = await Promise.all([
            user.getList(domainId, uids),
            discussion.getNodes(domainId),
        ]);
        const path = [
            ['Hydro', 'homepage'],
            ['discussion_main', 'discussion_main'],
            [this.vnode.title, null, true],
        ];
        const vndict = { [typeMapper[type]]: { [name.toString()]: this.vnode } };
        this.response.template = 'discussion_main_or_node.html';
        this.response.body = {
            ddocs,
            dpcount,
            udict,
            path,
            page,
            vndict,
            vnode: this.vnode,
            page_name: 'discussion_node',
            vnodes,
        };
    }
}

class DiscussionCreateHandler extends DiscussionHandler {
    async get({ type, name }) {
        const path = [
            ['Hydro', 'homepage'],
            ['discussion_main', 'discussion_main'],
            [this.vnode.title, 'discussion_node', { type, name }, true],
            ['discussion_create', null],
        ];
        this.response.template = 'discussion_create.html';
        this.response.body = { path, vnode: this.vnode };
    }

    @param('type', Types.String)
    @param('name', Types.String)
    @param('title', Types.String, isTitle)
    @param('content', Types.String, isContent)
    @param('highlight', Types.Boolean)
    @param('pin', Types.Boolean)
    async post(
        domainId: string, type: string, _name: string,
        title: string, content: string, highlight = false, pin = false,
    ) {
        this.limitRate('add_discussion', 3600, 30);
        let name: ObjectID | string | number;
        if (ObjectID.isValid(_name)) name = new ObjectID(_name);
        else if (isSafeInteger(parseInt(_name, 10))) name = parseInt(_name, 10);
        else name = _name;
        if (highlight) this.checkPerm(PERM.PERM_HIGHLIGHT_DISCUSSION);
        if (pin) this.checkPerm(PERM.PERM_PIN_DISCUSSION);
        const did = await discussion.add(
            domainId, typeMapper[type], name, this.user._id,
            title, content, this.request.ip, highlight, pin,
        );
        this.response.body = { did };
        this.response.redirect = this.url('discussion_detail', { did });
    }
}

class DiscussionDetailHandler extends DiscussionHandler {
    @param('did', Types.ObjectID)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, did: ObjectID, page = 1) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await discussion.getStatus(domainId, did, this.user._id)
            : null;
        const [drdocs, pcount, drcount] = await paginate(
            discussion.getMultiReply(domainId, did),
            page,
            CONSTANT.REPLY_PER_PAGE,
        );
        const uids = drdocs.map((drdoc) => drdoc.owner);
        uids.push(this.ddoc.owner);
        for (const drdoc of drdocs) {
            if (drdoc.reply) {
                drdocs.forEach((drrdoc) => uids.push(drrdoc.owner));
            }
        }
        const udict = await user.getList(domainId, uids);
        const path = [
            ['Hydro', 'homepage'],
            ['discussion_main', 'discussion_main'],
            [this.vnode.title, 'discussion_node', { type: discussion.typeDisplay[this.ddoc.parentType], name: this.ddoc.parentId }, true],
            [this.ddoc.title, null, null, true],
        ];
        this.response.template = 'discussion_detail.html';
        this.response.body = {
            path, ddoc: this.ddoc, dsdoc, drdocs, page, pcount, drcount, udict, vnode: this.vnode,
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('did', Types.ObjectID)
    @param('content', Types.String, isContent)
    async postReply(domainId: string, did: ObjectID, content: string) {
        this.checkPerm(PERM.PERM_REPLY_DISCUSSION);
        this.limitRate('add_discussion', 3600, 30);
        // Notify related users
        const replies: Drdoc[] = await discussion.getMultiReply(domainId, did).toArray();
        const uids = Array.from(new Set(replies.map((drdoc) => drdoc.owner)));
        const tasks = uids.map((uid) => {
            if (uid !== this.user._id) {
                return message.send(1, uid, `Discussion update: ${domainId} ${did}`);
            }
            return Promise.resolve(null as Mdoc);
        });
        await Promise.all(tasks);
        await discussion.addReply(domainId, did, this.user._id, content, this.request.ip);
        this.back();
    }

    @param('drid', Types.ObjectID)
    @param('content', Types.String, isContent)
    async postTailReply(domainId: string, drid: ObjectID, content: string) {
        this.checkPerm(PERM.PERM_REPLY_DISCUSSION);
        this.limitRate('add_discussion', 3600, 30);
        await discussion.addTailReply(domainId, drid, this.user._id, content, this.request.ip);
        this.back();
    }

    @param('drid', Types.ObjectID)
    @param('content', Types.String, isContent)
    async postEditReply(domainId: string, drid: ObjectID, content: string) {
        this.checkPerm(PERM.PERM_EDIT_DISCUSSION_REPLY_SELF);
        if (this.drdoc.owner !== this.user._id) throw new PermissionError(PERM.PERM_EDIT_DISCUSSION_REPLY_SELF);
        await discussion.editReply(domainId, drid, content);
        this.back();
    }

    @param('drid', Types.ObjectID)
    async postDeleteReply(domainId: string, drid: ObjectID) {
        if (!(this.ddoc.owner === this.user._id
            && this.user.hasPerm(PERM.PERM_DELETE_DISCUSSION_REPLY_SELF_DISCUSSION))) {
            if (this.drdoc.owner !== this.user._id) {
                this.checkPerm(PERM.PERM_DELETE_DISCUSSION_REPLY);
            } else this.checkPerm(PERM.PERM_DELETE_DISCUSSION_SELF);
        }
        await discussion.delReply(domainId, drid);
        await oplog.add({ ...this.drdoc, operator: this.user._id, type: 'drdoc' });
        this.back();
    }

    @param('drid', Types.ObjectID)
    @param('drrid', Types.ObjectID)
    @param('content', Types.String, isContent)
    async postEditTailReply(domainId: string, drid: ObjectID, drrid: ObjectID, content: string) {
        this.checkPerm(PERM.PERM_EDIT_DISCUSSION_REPLY_SELF);
        if (this.drdoc.owner !== this.user._id) throw new PermissionError(PERM.PERM_EDIT_DISCUSSION_REPLY_SELF);
        await discussion.editTailReply(domainId, drid, drrid, content);
        this.back();
    }

    @param('drid', Types.ObjectID)
    @param('drrid', Types.ObjectID)
    async postDeleteTailReply(domainId: string, drid: ObjectID, drrid: ObjectID) {
        if (this.drrdoc.owner !== this.user._id) this.checkPerm(PERM.PERM_DELETE_DISCUSSION_REPLY);
        await discussion.delTailReply(domainId, drid, drrid);
        await oplog.add({ ...this.drrdoc, operator: this.user._id, type: 'drrdoc' });
        this.back();
    }

    @param('did', Types.ObjectID)
    async postStar(domainId: string, did: ObjectID) {
        await discussion.setStar(domainId, did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectID)
    async postUnstar(domainId: string, did: ObjectID) {
        await discussion.setStar(domainId, did, this.user._id, false);
        this.back({ star: false });
    }
}

class DiscussionDetailRawHandler extends DiscussionHandler {
    async get() {
        this.response.type = 'text/markdown';
        this.response.body = this.ddoc.content;
    }
}

class DiscussionReplyRawHandler extends DiscussionHandler {
    async get() {
        this.response.type = 'text/markdown';
        this.response.body = this.drdoc.content;
    }
}

class DiscussionTailReplyRawHandler extends DiscussionHandler {
    async get() {
        this.response.type = 'text/markdown';
        this.response.body = this.drrdoc.content;
    }
}

class DiscussionEditHandler extends DiscussionHandler {
    async get() {
        const path = [
            ['Hydro', 'homepage'],
            ['discussion_main', 'discussion_main'],
            [this.vnode.title, 'discussion_node', { type: discussion.typeDisplay[this.ddoc.parentType], name: this.ddoc.parentId }, true],
            [this.ddoc.title, 'discussion_detail', { did: this.ddoc.docId }, true],
            ['discussion_edit', null],
        ];
        this.response.template = 'discussion_edit.html';
        this.response.body = { ddoc: this.ddoc, path };
    }

    @param('did', Types.ObjectID)
    @param('title', Types.String, isTitle)
    @param('content', Types.String, isContent)
    @param('highlight', Types.Boolean)
    @param('pin', Types.Boolean)
    async postUpdate(
        domainId: string, did: ObjectID, title: string, content: string,
        highlight = false, pin = false,
    ) {
        if (this.ddoc.owner !== this.user._id) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        else this.checkPerm(PERM.PERM_EDIT_DISCUSSION_SELF);
        if (highlight !== this.ddoc.highlight) this.checkPerm(PERM.PERM_HIGHLIGHT_DISCUSSION);
        if (pin !== this.ddoc.pin) this.checkPerm(PERM.PERM_PIN_DISCUSSION);
        await discussion.edit(domainId, did, title, content, highlight, pin);
        this.response.body = { did };
        this.response.redirect = this.url('discussion_detail', { did });
    }

    @param('did', Types.ObjectID)
    async postDelete(domainId: string, did: ObjectID) {
        if (this.ddoc.owner !== this.user._id) this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        else this.checkPerm(PERM.PERM_DELETE_DISCUSSION_SELF);
        await discussion.del(domainId, did);
        await oplog.add({ ...this.ddoc, operator: this.user._id, type: 'ddoc' });
        this.response.body = { type: this.ddoc.parentType, parent: this.ddoc.parentId };
        this.response.redirect = this.url('discussion_node', {
            type: discussion.typeDisplay[this.ddoc.parentType],
            name: this.ddoc.parentId,
        });
    }
}

export async function apply() {
    Route('discussion_main', '/discuss', DiscussionMainHandler);
    Route('discussion_detail', '/discuss/:did', DiscussionDetailHandler);
    Route('discussion_edit', '/discuss/:did/edit', DiscussionEditHandler);
    Route('discussion_detail', '/discuss/:did/raw', DiscussionDetailRawHandler);
    Route('discussion_reply_raw', '/discuss/:did/:drid/raw', DiscussionReplyRawHandler);
    Route('discussion_tail_reply_raw', '/discuss/:did/:drid/:drrid/raw', DiscussionTailReplyRawHandler);
    Route('discussion_node', '/discuss/:type/:name', DiscussionNodeHandler);
    Route('discussion_create', '/discuss/:type/:name/create', DiscussionCreateHandler, PRIV.PRIV_USER_PROFILE, PERM.PERM_CREATE_DISCUSSION);
}

global.Hydro.handler.discussion = apply;
