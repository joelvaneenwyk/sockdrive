const events = require("events");
const streams = require("stream");
const fifolock = require("fifolock");
const S = require("./structs.js");
const _ = require("./helpers.js");

// _.log.level = _.log.DBG;

export function createFileSystem(volume: { writeSectors: any; sectorSize: any; readSectors: (arg0: number, arg1: any, arg2: (e: any) => void) => void; }, opts: { ro: boolean; noatime: boolean; } | null, cb: (arg0: string, arg1: null) => any) {
    if (typeof opts === "function") {
        cb = opts;
        opts = null;
    }
    opts = _.extend(
        {
            // c.f. https://www.kernel.org/doc/Documentation/filesystems/vfat.txt
            ro: false,
            noatime: true,
            modmode: 0o111, // or `0o7000`
            umask: "umask" in process ? process.umask() : 0o022,
            uid: "getuid" in process ? process.getuid() : 0,
            gid: "getgid" in process ? process.getgid() : 0,
        },
        opts,
    );
    if (!volume.writeSectors) opts.ro = true;
    if (opts.ro) opts.noatime = true; // natch

    const fs = new events.EventEmitter();
    let vol: { rootDirectoryChain: any; chainForCluster: (arg0: any) => any; opts: { ro: any; noatime: any; }; } | null = null;
    const dir = require("./dir.js");
    const c = require("./chains.js");
    const q = fifolock();

    const GROUP =
        _.log.level < _.log.INFO
            ? q.TRANSACTION_WRAPPER.bind({
                  postAcquire: function (proceed: () => void) {
                      _.log(_.log.DBG, "=== Starting GROUP ===");
                      proceed();
                  },
                  preRelease: function (finish: () => void) {
                      _.log(_.log.DBG, "=== Finishing GROUP ===");
                      finish();
                  },
              })
            : q.TRANSACTION_WRAPPER;

    q.acquire(function (unlock: () => void) {
        // because of this, callers can start before 'ready'
        const d = _.allocBuffer(volume.sectorSize);
        volume.readSectors(0, d, function (e: any) {
            if (e) fs.emit("error", e);
            else {
                try {
                    init(d);
                } catch (e) {
                    fs.emit("error", e);
                    unlock();
                    return;
                }
                fs.emit("ready");
            }
            unlock();
        });
    });

    if (cb) fs.on("error", cb).on("ready", () => cb("ready", null));

    function init(bootSector: any) {
        vol = require("./vol.js").init(volume, opts, bootSector);
        fs._dirIterator = dir.iterator.bind(dir);

        const entryInfoByPath = {};
        const baseEntry = {
            _refs: 0,
            _record: function () {
                entryInfoByPath[this.path] = this;
                if (this.parent) this.parent.retain();
                return this;
            },
            retain: function () {
                if (!this._refs) this._record();
                this._refs += 1;
                return this;
            },
            release: function () {
                this._refs -= 1;
                if (!this._refs) this._rescind();
            },
            _rescind: function () {
                if (this.parent) this.parent.release();
                delete entryInfoByPath[this.path];
            },
        };
        fs._createSharedEntry = function (path: any, entry: any, chain: any, parent: any) {
            return _.extend(Object.create(baseEntry), {
                _refs: 0, // WORKAROUND: https://github.com/tessel/beta/issues/455
                path: path,
                entry: entry,
                chain: chain,
                parent: parent,
            }).retain();
        };
        fs._createSharedEntry(
            "/",
            { Attr: { directory: true } },
            vol.rootDirectoryChain,
        );
        fs._sharedEntryForSteps = function (steps: any[], opts: { prepareForCreate: any; }, cb: (arg0: null, arg1: { missingChild: any; parent: any; } | undefined) => void) {
            // NOTE: may `cb` before returning!
            const path = steps.join("/") || "/";
            const name = steps.pop(); // n.b.
            const info = entryInfoByPath[path];
            if (info) cb(null, info.retain());
            else {
                fs._sharedEntryForSteps(steps, {}, function (e: any, parentInfo: { entry: { Attr: { directory: any; }; }; chain: any; }) {
                    // n.b. `steps` don't include `name`
                    if (e) cb(e);
                    else if (!parentInfo.entry.Attr.directory)
                        cb(S.err.NOTDIR());
                    else {
                        dir.findInDirectory(
                            vol,
                            parentInfo.chain,
                            name,
                            opts,
                            function (e: any, entry: { _firstCluster: any; }) {
                                if (e && !opts.prepareForCreate) cb(e);
                                else if (e)
                                    cb(e, {
                                        missingChild: _.extend(entry, {
                                            name: name,
                                        }),
                                        parent: parentInfo,
                                    });
                                else
                                    cb(
                                        null,
                                        fs._createSharedEntry(
                                            path,
                                            entry,
                                            vol.chainForCluster(
                                                entry._firstCluster,
                                            ),
                                            parentInfo,
                                        ),
                                    );
                            },
                        );
                    }
                });
            }
        };

        fs._updateEntry = dir.updateEntry.bind(dir, vol);
        fs._makeStat = dir.makeStat.bind(dir, vol);
        fs._addFile = dir.addFile.bind(dir, vol);
        fs._initDir = dir.init.bind(dir, vol);
    }

    /** ** ---- CORE API ---- ****/

    // NOTE: we really don't share namespace, but avoid first three anyway…
    const fileDescriptors = [null, null, null];

    fs.open = function (path: any, flags: any, mode: number, cb: (arg0: any, arg1: number | undefined) => void, _n_: string) {
        if (typeof mode === "function") {
            _n_ = cb;
            cb = mode;
            mode = 0o666;
        }
        cb = GROUP(
            cb,
            function () {
                const _fd = { flags: null, entry: null, chain: null, pos: 0 };
                const f = _.parseFlags(flags);
                if (vol.opts.ro && (f.write || f.create || f.truncate))
                    return _.delayedCall(cb, S.err.ROFS());
                else _fd.flags = f;

                fs._sharedEntryForSteps(
                    _.absoluteSteps(path),
                    { prepareForCreate: f.create },
                    function (e: { code: string; }, info: { parent: { chain: any; }; missingChild: any; entry: { Attr: { directory: any; readonly: any; }; }; }) {
                        if (e && !(e.code === "NOENT" && f.create && info))
                            cb(e);
                        else if (e) {
                            fs._addFile(
                                info.parent.chain,
                                info.missingChild,
                                { dir: f._openDir },
                                function (e: any, newEntry: any, newChain: any) {
                                    if (e) cb(e);
                                    else
                                        finish(
                                            fs._createSharedEntry(
                                                _.absolutePath(path),
                                                newEntry,
                                                newChain,
                                                info.parent,
                                            ),
                                        );
                                },
                            );
                        } else if (info && f.exclusive) cb(S.err.EXIST());
                        else if (info.entry.Attr.directory && !f._openDir)
                            cb(S.err.ISDIR());
                        else if (f.write && info.entry.Attr.readonly)
                            cb(S.err.ACCES());
                        else finish(info);
                        function finish(fileInfo: { entry: null; chain: null; }) {
                            const fd = fileDescriptors.push(_fd) - 1;
                            _fd.info = fileInfo;
                            _fd.entry = fileInfo.entry;
                            _fd.chain = fileInfo.chain;
                            if (f.append) _fd.pos = _fd.entry._size;
                            if (f._openDir) _fd.chain.cacheAdvice = "WILLNEED";
                            if (f.truncate && _fd.entry._size) {
                                fs.ftruncate(
                                    fd,
                                    0,
                                    function (e: any) {
                                        cb(e, fd);
                                    },
                                    "_nested_",
                                );
                            } else _.delayedCall(cb, null, fd); // (delay in case fs._sharedEntryForSteps all cached!)
                        }
                    },
                );
            },
            _n_ === "_nested_",
        );
    };

    fs.fstat = function (fd: string | number, cb: any, _n_: string) {
        cb = GROUP(
            cb,
            function () {
                const _fd = fileDescriptors[fd];
                if (!_fd || !_fd.flags.read) _.delayedCall(cb, S.err.BADF());
                else _.delayedCall(cb, null, fs._makeStat(_fd.entry));
            },
            _n_ === "_nested_",
        );
    };

    fs.futimes = function (fd: string | number, atime: any, mtime: any, cb: any, _n_: string) {
        cb = GROUP(
            cb,
            function () {
                const _fd = fileDescriptors[fd];
                if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());
                // NOTE: ctime would get touched on POSIX; but we map that to create time!
                else
                    fs._updateEntry(
                        _fd.entry,
                        { atime: atime || true, mtime: mtime || true },
                        cb,
                    );
            },
            _n_ === "_nested_",
        );
    };

    fs.fchmod = function (fd: string | number, mode: number, cb: any, _n_: string) {
        cb = GROUP(
            cb,
            function () {
                const _fd = fileDescriptors[fd];
                if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());
                else {
                    mode &= S._I._chmoddable;
                    if (_fd.entry.Attr.directory) mode |= S._I.FDIR;
                    else if (!_fd.entry.Attr.volume_id) mode |= S._I.FREG;
                    fs._updateEntry(_fd.entry, { mode: mode }, cb);
                }
            },
            _n_ === "_nested_",
        );
    };

    fs.read = function (fd: string | number, buf: string | any[], off: number, len: number, pos: null, cb: (arg0: any, arg1: any, arg2: any) => void, _n_: string) {
        cb = GROUP(
            cb,
            function () {
                const _fd = fileDescriptors[fd];
                if (!_fd || !_fd.flags.read)
                    return _.delayedCall(cb, S.err.BADF());

                const _pos = pos === null ? _fd.pos : pos;
                const _len = Math.min(len, _fd.entry._size - _pos);
                const _buf = buf.slice(off, off + _len);
                _fd.chain.readFromPosition(
                    _pos,
                    _buf,
                    function (e: any, bytes: any, slice: any) {
                        if (_.workaroundTessel380) _buf.copy(buf, off); // WORKAROUND: https://github.com/tessel/beta/issues/380
                        _fd.pos = _pos + bytes;
                        if (e || vol.opts.noatime) finish(e);
                        else
                            fs._updateEntry(_fd.entry, { atime: true }, finish);
                        function finish(e: any) {
                            cb(e, bytes, buf);
                        }
                    },
                );
            },
            _n_ === "_nested_",
        );
    };

    fs._readdir = function (fd: string | number, cb: (arg0: null, arg1: any[] | undefined) => void, _n_: string) {
        cb = GROUP(
            cb,
            function () {
                const _fd = fileDescriptors[fd];
                if (!_fd || !_fd.flags.read)
                    return _.delayedCall(cb, S.err.BADF());

                const entryNames: any[] = [];
                const getNextEntry = fs._dirIterator(_fd.chain);
                function processNext() {
                    getNextEntry(function (e: any, d: { _name: string; }) {
                        if (e) cb(e);
                        else if (!d && !entryNames.length)
                            cb(null, entryNames); // WORKAROUND: https://github.com/tessel/beta/issues/435
                        else if (!d)
                            cb(null, entryNames.sort()); // NOTE: sort not required, but… [simplifies tests for starters!]
                        else {
                            if (d._name !== "." && d._name !== "..")
                                entryNames.push(d._name);
                            processNext();
                        }
                    });
                }
                processNext();
            },
            _n_ === "_nested_",
        );
    };

    fs._mkdir = function (fd: string | number, cb: any, _n_: string) {
        cb = GROUP(
            cb,
            function () {
                const _fd = fileDescriptors[fd];
                if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());
                else fs._initDir(_fd.info, cb);
            },
            _n_ === "_nested_",
        );
    };

    fs.write = function (fd: string | number, buf: string | any[], off: any, len: any, pos: null, cb: (arg0: any, arg1: any, arg2: any) => void, _n_: string) {
        cb = GROUP(
            cb,
            function () {
                const _fd = fileDescriptors[fd];
                if (!_fd || !_fd.flags.write)
                    return _.delayedCall(cb, S.err.BADF());

                let _pos = pos === null || _fd.flags.append ? _fd.pos : pos;
                let _buf = buf.slice(off, off + len);
                if (_pos > _fd.entry._size) {
                    // TODO: handle huge jumps by zeroing clusters individually?
                    const padLen = _pos - _fd.entry._size;
                    const padBuf = _.allocBuffer(padLen + _buf.length);
                    padBuf.fill(0x00, 0, padLen);
                    _buf.copy(padBuf, padLen);
                    _pos = _fd.entry._size;
                    _buf = padBuf;
                }
                _fd.chain.writeToPosition(_pos, _buf, function (e: any) {
                    _fd.pos = _pos + len;
                    const newSize = Math.max(_fd.entry._size, _fd.pos);
                    const newInfo = { size: newSize, _touch: true };
                    fs._updateEntry(_fd.entry, newInfo, function (ee: any) {
                        cb(e || ee, len, buf);
                    });
                });
            },
            _n_ === "_nested_",
        );
    };

    fs.ftruncate = function (fd: string | number, len: number, cb: (arg0: any) => void, _n_: string) {
        cb = GROUP(
            cb,
            function () {
                const _fd = fileDescriptors[fd];
                if (!_fd || !_fd.flags.write)
                    return _.delayedCall(cb, S.err.BADF());

                const newStats = { size: len, _touch: true };
                // NOTE: we order operations for best state in case of only partial success
                if (len === _fd.entry._size) _.delayedCall(cb);
                else if (len < _fd.entry._size) {
                    fs._updateEntry(_fd.entry, newStats, function (e: any) {
                        if (e) cb(e);
                        else
                            _fd.chain.truncate(
                                Math.ceil(len / _fd.chain.sectorSize),
                                cb,
                            );
                    });
                } // TODO: handle huge file expansions without as much memory pressure
                else {
                    _fd.chain.writeToPosition(
                        _fd.entry._size,
                        _.allocBuffer(len - _fd.entry._size, 0x00),
                        function (e: any) {
                            if (e) cb(e);
                            else fs._updateEntry(_fd.entry, newStats, cb);
                        },
                    );
                }
            },
            _n_ === "_nested_",
        );
    };

    // 'NORMAL', 'SEQUENTIAL', 'RANDOM', 'WILLNEED', 'DONTNEED', 'NOREUSE'
    fs._fadviseSync = function (fd: string | number, off: number, len: number, advice: any) {
        if (off !== 0 || len !== 0)
            throw Error(
                "Cache advise can currently be given only for whole file!",
            );
        const _fd = fileDescriptors[fd];
        if (!_fd) throw S.err.BADF();
        else _fd.chain.cacheAdvice = advice;
    };

    fs.fsync = function (fd: string | number, cb: any) {
        // NOTE: we'll need to flush write cache here once we have one…
        const _fd = fileDescriptors[fd];
        if (!_fd) _.delayedCall(cb, S.err.BADF());
        else _.delayedCall(cb);
    };

    fs.close = function (fd: string | number, cb: any) {
        const _fd = fileDescriptors[fd];
        if (!_fd) _.delayedCall(cb, S.err.BADF());
        else
            setTimeout(_fd.info.release.bind(_fd.info), 500),
                _.delayedCall(cb, (fileDescriptors[fd] = null));
    };

    /* STREAM WRAPPERS */

    let workaroundTessel436: boolean;
    try {
        new require("stream").Readable({ encoding: "utf8" });
        new streams.Readable({ encoding: "utf8" });
    } catch (e) {
        workaroundTessel436 = true;
    }

    function _createStream(StreamType: new (arg0: any) => any, path: any, opts: { encoding: any; fd: null; start: any; flags: any; mode: any; autoClose: any; end: number; }) {
        // [NOT REALLY A] WORKAROUND: https://github.com/tessel/beta/issues/436
        if (workaroundTessel436 && "encoding" in opts) {
            console.warn(
                "Tessel does not currently support encoding option for Readable streams, discarding!",
            );
            delete opts.encoding;
        }

        let fd = opts.fd !== null ? opts.fd : "_opening_";
        let pos = opts.start;
        const stream = new StreamType(opts);

        if (fd === "_opening_") {
            fs.open(path, opts.flags, opts.mode, function (e: any, _fd: any) {
                if (e) {
                    fd = "_open_error_";
                    stream.emit("error", e);
                } else {
                    fd = _fd;
                    fs._fadviseSync(fd, 0, 0, "SEQUENTIAL");
                    stream.emit("open", fd);
                }
            });
        }

        function autoClose(tombstone: string) {
            // NOTE: assumes caller will clear `fd`
            if (opts.autoClose) {
                fs.close(fd, function (e: any) {
                    if (e) stream.emit("error", e);
                    else stream.emit("close");
                });
            }
            fd = tombstone;
        }

        if (StreamType === streams.Readable) {
            stream._read = function (n: number) {
                let buf;
                // TODO: optimize to fetch at least a full sector regardless of `n`…
                n = Math.min(n, opts.end - pos);
                if (fd === "_opening_") {
                    stream.once("open", function () {
                        stream._read(n);
                    });
                } else if (pos > opts.end) stream.push(null);
                else if (n > 0) {
                    (buf = _.allocBuffer(n)),
                        fs.read(fd, buf, 0, n, pos, function (e: any, n: any, d: string | any[]) {
                            if (e) {
                                autoClose("_read_error_");
                                stream.emit("error", e);
                            } else stream.push(n ? d.slice(0, n) : null);
                        }),
                        (pos += n);
                } else stream.push(null);
            };

            stream.once("end", function () {
                autoClose("_ended_");
            });
        } else if (StreamType === streams.Writable) {
            stream.bytesWritten = 0;

            stream._write = function (data: string | any[], _enc: any, cb: (arg0: undefined) => void) {
                if (fd === "_opening_") {
                    stream.once("open", function () {
                        stream._write(data, null, cb);
                    });
                } else {
                    fs.write(fd, data, 0, data.length, pos, function (e: any, n: any) {
                        if (e) {
                            autoClose("_write_error_");
                            cb(e);
                        } else {
                            stream.bytesWritten += n;
                            cb();
                        }
                    }),
                        (pos += data.length);
                }
            };

            stream.once("finish", function () {
                autoClose("_finished_");
            });
        }

        return stream;
    }

    fs.createReadStream = function (path: any, opts: any) {
        return _createStream(
            streams.Readable,
            path,
            _.extend(
                {
                    start: 0,
                    end: Infinity,
                    flags: "r",
                    mode: 0o666,
                    encoding: null,
                    fd: null, // ??? see https://github.com/joyent/node/issues/7708
                    autoClose: true,
                },
                opts,
            ),
        );
    };

    fs.createWriteStream = function (path: any, opts: any) {
        return _createStream(
            streams.Writable,
            path,
            _.extend(
                {
                    start: 0,
                    flags: "w",
                    mode: 0o666,
                    // encoding: null,   // see https://github.com/joyent/node/issues/7710
                    fd: null, // ??? see https://github.com/joyent/node/issues/7708
                    autoClose: true,
                },
                opts,
                { decodeStrings: true, objectMode: false },
            ),
        );
    };

    /* PATH WRAPPERS (albeit the only public interface for some folder operations) */

    function _fdOperation(path: any, opts: { flag: any; advice?: any; }, fn: { (fd: any, cb: any): void; (fd: any, cb: any): void; (fd: any, cb: any): void; (fd: any, cb: any): void; (fd: any, cb: any): void; (fd: any, cb: any): void; (fd: any, cb: any): void; (fd: any, cb: any): void; (fd: any, cb: any): void; (fd: any, cb: any): void; (fd: any, cb: any): void; (arg0: any, arg1: () => void): any; }, cb: { (arg0: any): void; (arg0: any): void; apply: any; }) {
        cb = GROUP(cb, function () {
            opts.advice || (opts.advice = "NORMAL");
            fs.open(
                path,
                opts.flag,
                function (e: any, fd: any) {
                    if (e) cb(e);
                    else {
                        fs._fadviseSync(fd, 0, 0, opts.advice),
                            fn(fd, function () {
                                const ctx = this;
                                const args = arguments;
                                fs.close(
                                    fd,
                                    function (closeErr: any) {
                                        cb.apply(ctx, args);
                                    },
                                    "_nested_",
                                );
                            });
                    }
                },
                "_nested_",
            );
        });
    }

    fs.stat = fs.lstat = function (path: any, cb: any) {
        _fdOperation(
            path,
            { flag: "r" },
            function (fd: any, cb: any) {
                fs.fstat(fd, cb, "_nested_");
            },
            cb,
        );
    };

    fs.exists = function (path: any, cb: (arg0: boolean) => void) {
        fs.stat(path, function (err: any) {
            cb(err ? false : true);
        });
    };

    fs.readFile = function (path: any, opts: { flag?: any; advice?: any; encoding?: any; }, cb: any) {
        if (typeof opts === "function") {
            cb = opts;
            opts = {};
        }
        opts.flag || (opts.flag = "r");
        opts.advice || (opts.advice = "NOREUSE");
        _fdOperation(
            path,
            opts,
            function (fd: any, cb: (arg0: null, arg1: undefined) => void) {
                fs.fstat(
                    fd,
                    function (e: any, stat: { size: any; }) {
                        if (e) return cb(e);
                        else {
                            const buffer = _.allocBuffer(stat.size);
                            fs.read(
                                fd,
                                buffer,
                                0,
                                buffer.length,
                                null,
                                function (e: any) {
                                    if (e) cb(e);
                                    else
                                        cb(
                                            null,
                                            opts.encoding
                                                ? buffer.toString(opts.encoding)
                                                : buffer,
                                        );
                                },
                                "_nested_",
                            );
                        }
                    },
                    "_nested_",
                );
            },
            cb,
        );
    };

    fs.writeFile = function (path: any, data: string | any[], opts: { flag?: any; advice?: any; encoding?: any; }, cb: any) {
        if (typeof opts === "function") {
            cb = opts;
            opts = {};
        }
        opts.flag || (opts.flag = "w");
        opts.advice || (opts.advice = "NOREUSE");
        _fdOperation(
            path,
            opts,
            function (fd: any, cb: (arg0: any) => void) {
                if (typeof data === "string")
                    data = _.bufferFrom(data, opts.encoding || "utf8");
                fs.write(
                    fd,
                    data,
                    0,
                    data.length,
                    null,
                    function (e: any) {
                        cb(e);
                    },
                    "_nested_",
                );
            },
            cb,
        );
    };

    fs.appendFile = function (path: any, data: any, opts: { flag?: any; }, cb: any) {
        if (typeof opts === "function") {
            cb = opts;
            opts = {};
        }
        opts.flag || (opts.flag = "a");
        fs.writeFile(path, data, opts, cb);
    };

    fs.truncate = function (path: any, len: any, cb: any) {
        _fdOperation(
            path,
            { flag: "r+" },
            function (fd: any, cb: any) {
                fs.ftruncate(fd, len, cb, "_nested_");
            },
            cb,
        );
    };

    fs.readdir = function (path: any, cb: any) {
        _fdOperation(
            path,
            { flag: "\\r" },
            function (fd: any, cb: any) {
                fs._readdir(fd, cb, "_nested_");
            },
            cb,
        );
    };

    fs.mkdir = function (path: any, mode: number, cb: any) {
        if (typeof mode === "function") {
            cb = mode;
            mode = 0o777;
        }
        _fdOperation(
            path,
            { flag: "\\wx" },
            function (fd: any, cb: any) {
                fs._mkdir(fd, cb, "_nested_");
            },
            cb,
        );
    };

    fs.utimes = function (path: any, atime: any, mtime: any, cb: any) {
        _fdOperation(
            path,
            { flag: "r+" },
            function (fd: any, cb: any) {
                fs.futimes(fd, atime, mtime, cb, "_nested_");
            },
            cb,
        );
    };

    fs.chmod = fs.lchmod = function (path: any, mode: any, cb: any) {
        _fdOperation(
            path,
            { flag: "\\r+" },
            function (fd: any, cb: any) {
                fs.fchmod(fd, mode, cb, "_nested_");
            },
            cb,
        );
    };

    fs.chown = fs.lchown = function (path: any, uid: any, gid: any, cb: any) {
        _fdOperation(
            path,
            { flag: "\\r+" },
            function (fd: any, cb: any) {
                fs.fchown(fd, uid, gid, cb, "_nested_");
            },
            cb,
        );
    };

    /* STUBS */

    fs.link = function (src: any, dst: any, cb: any) {
        // NOTE: theoretically we _could_ do hard links [with untracked `stat.nlink` count…]
        _.delayedCall(cb, S.err.NOSYS());
    };

    fs.symlink = function (src: any, dst: any, type: null, cb: any) {
        if (typeof type === "function") {
            cb = type;
            type = null;
        }
        _.delayedCall(cb, S.err.NOSYS());
    };

    fs.readlink = function (path: any, cb: any) {
        _fdOperation(
            path,
            { flag: "\\r" },
            function (fd: any, cb: (arg0: any) => void) {
                // the named file is *never* a symbolic link…
                // NOTE: we still use _fdOperation for catching e.g. NOENT/NOTDIR errors…
                cb(S.err.INVAL());
            },
            cb,
        );
    };

    fs.realpath = function (path: any, cache: null, cb: any) {
        if (typeof cache === "function") {
            cb = cache;
            cache = null;
        }
        if (cache)
            _.delayedCall(cb, S.err.NOSYS()); // TODO: what would be involved here?
        else {
            _fdOperation(
                path,
                { flag: "\\r" },
                function (fd: any, cb: (arg0: null, arg1: any) => void) {
                    cb(null, _.absolutePath(path));
                },
                cb,
            );
        }
    };

    fs.fchown = function (fd: string | number, uid: any, gid: any, cb: any, _n_: string) {
        cb = GROUP(
            cb,
            function () {
                const _fd = fileDescriptors[fd];
                if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());
                else _.delayedCall(cb, S.err.NOSYS());
            },
            _n_ === "_nested_",
        );
    };

    return fs;
};
