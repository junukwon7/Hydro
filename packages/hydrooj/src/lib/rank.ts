function* ranked<T>(diter: T[], equ = (a: T, b: T) => a === b): Generator<[number, T], void> {
    let last = null;
    let r = 0;
    let count = 0;
    for (const doc of diter) {
        count++;
        if (count === 1 || !equ(last, doc)) r = count;
        last = doc;
        yield [r, doc];
    }
}

global.Hydro.lib.rank = ranked;
export = ranked;
