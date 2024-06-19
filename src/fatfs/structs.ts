// see http://staff.washington.edu/dittrich/misc/fatgen103.pdf
// and http://www.cse.scu.edu/~tschwarz/COEN252_09/Lectures/FAT.html

const _ = require("struct-fu");
const __ = require("./helpers.js");

const bootBase = _.struct([
    _.byte("jmpBoot", 3),
    _.char("OEMName", 8),
    _.uint16le("BytsPerSec"),
    _.uint8("SecPerClus"),
    _.uint16le("ResvdSecCnt"), // Rsvd in table, but Resvd in calcs…
    _.uint8("NumFATs"),
    _.uint16le("RootEntCnt"),
    _.uint16le("TotSec16"),
    _.uint8("Media"),
    _.uint16le("FATSz16"),
    _.uint16le("SecPerTrk"),
    _.uint16le("NumHeads"),
    _.uint32le("HiddSec"),
    _.uint32le("TotSec32"),
]);

const bootInfo = _.struct([
    _.uint8("DrvNum"),
    _.uint8("Reserved1"),
    _.uint8("BootSig"),
    _.uint32le("VolID"),
    _.char("VolLab", 11),
    _.char("FilSysType", 8),
]);

export var boot16 = _.struct([bootBase, bootInfo]);

export var boot32 = _.struct([
    bootBase,
    _.uint32le("FATSz32"),
    _.struct(
        "ExtFlags",
        [
            _.ubit("NumActiveFAT", 4),
            _.ubit("_reserved1", 3),
            _.bool("MirroredFAT"),
            _.ubit("_reserved2", 8),
        ].reverse(),
    ),
    _.struct("FSVer", [_.uint8("Major"), _.uint8("Minor")]),
    _.uint32le("RootClus"),
    _.uint16le("FSInfo"),
    _.uint16le("BkBootSec"),
    _.byte("Reserved", 12),
    bootInfo,
]);

const _time = _.struct([
    _.ubit("hours", 5),
    _.ubit("minutes", 6),
    _.ubit("seconds_2", 5),
]);
const time = {
    valueFromBytes: function (buf, off) {
        off || (off = { bytes: 0 });

        const _buf = __.bufferFrom([buf[off.bytes + 1], buf[off.bytes + 0]]);
        const val = _time.valueFromBytes(_buf);
        off.bytes += this.size;
        return val;
    },
    bytesFromValue: function (val, buf, off) {
        val || (val = { hours: 0, minutes: 0, seconds_2: 0 });
        buf || (buf = __.allocBuffer(this.size));
        off || (off = { bytes: 0 });

        const _buf = _time.bytesFromValue(val);
        buf[off.bytes + 1] = _buf[0];
        buf[off.bytes + 0] = _buf[1];
        off.bytes += this.size;
        return buf;
    },
    size: _time.size,
};

const _date = _.struct([
    _.ubit("year", 7),
    _.ubit("month", 4),
    _.ubit("day", 5),
]);
const date = {
    valueFromBytes: function (buf, off) {
        off || (off = { bytes: 0 });

        const _buf = __.bufferFrom([buf[off.bytes + 1], buf[off.bytes + 0]]);
        const val = _date.valueFromBytes(_buf);
        off.bytes += this.size;
        return val;
    },
    bytesFromValue: function (val, buf, off) {
        val || (val = { year: 0, month: 0, day: 0 });
        buf || (buf = __.allocBuffer(this.size));
        off || (off = { bytes: 0 });

        const _buf = _date.bytesFromValue(val);
        buf[off.bytes + 1] = _buf[0];
        buf[off.bytes + 0] = _buf[1];
        off.bytes += this.size;
        return buf;
    },
    size: _date.size,
};

export var dirEntry = _.struct([
    _.struct("Name", [_.char("filename", 8), _.char("extension", 3)]),
    _.struct(
        "Attr",
        [
            _.bool("readonly"),
            _.bool("hidden"),
            _.bool("system"),
            _.bool("volume_id"),
            _.bool("directory"),
            _.bool("archive"),
            _.ubit("reserved", 2),
        ].reverse(),
    ),
    _.byte("NTRes", 1),
    _.uint8("CrtTimeTenth"),
    _.struct("CrtTime", [time]),
    _.struct("CrtDate", [date]),
    _.struct("LstAccDate", [date]),
    _.uint16le("FstClusHI"),
    _.struct("WrtTime", [time]),
    _.struct("WrtDate", [date]),
    _.uint16le("FstClusLO"),
    _.uint32le("FileSize"),
]);
export var entryDoneFlag = 0x00;
export var entryFreeFlag = 0xe5;
export var entryIsE5Flag = 0x05;

export var dirEntry_simple = _.struct([
    _.struct("Name", [_.char("filename", 8), _.char("extension", 3)]),
    _.padTo(dirEntry.size),
    /*
    _.uint8('Attr_raw'),
    _.byte('NTRes', 1),
    _.byte('Crt_raw', 1+2+2),
    _.byte('Lst_raw', 2),
    _.uint16le('FstClusHI'),
    _.byte('Wrt_raw', 2+2),
    _.uint16le('FstClusLO'),
    _.uint32le('FileSize')
    */
]);

export var lastLongFlag = 0x40;
export var longDirFlag = 0x0f;
export var longDirEntry = _.struct([
    _.uint8("Ord"),
    _.char16le("Name1", 10),
    _.uint8("Attr_raw"),
    _.uint8("Type"),
    _.uint8("Chksum"),
    _.char16le("Name2", 12),
    _.uint16le("FstClusLO"),
    _.char16le("Name3", 4),
]);

if (longDirEntry.size !== dirEntry.size) throw Error("Structs ain't right!");

export var fatField = {
    fat12: _.struct("Status", [
        _.ubit("field0bc", 8),
        _.ubit("field1c", 4),
        _.ubit("field0a", 4),
        _.ubit("field1ab", 8),
    ]),
    fat16: _.uint16le("Status"),
    fat32: _.uint32le("Status"), // more properly this 4 bits reserved + uint28le
};

export var fatPrefix = {
    fat12: 0xf00,
    fat16: 0xff00,
    fat32: 0x0fffff00,
};

export var fatStat = {
    free: 0x00,
    _undef: 0x01,
    rsvMin: 0xf0,
    bad: 0xf7,
    eofMin: 0xf8,
    eof: 0xff,
};

export var _I = {
    RUSR: 0o400,
    WUSR: 0o200,
    XUSR: 0o100,

    RGRP: 0o040,
    WGRP: 0o020,
    XGRP: 0o010,

    ROTH: 0o004,
    WOTH: 0o002,
    XOTH: 0o001,

    SUID: 0o4000,
    SGID: 0o2000,
    SVTX: 0o1000,

    FDIR: 0o40000,
    FREG: 0o100000,
};

export var RWXU = _I.RUSR | _I.WUSR | _I.XUSR;
export var RWXG = _I.RGRP | _I.WGRP | _I.XGRP;
export var RWXO = _I.ROTH | _I.WOTH | _I.XOTH;
export var _sss = _I.SUID | _I.SGID | _I.SVTX;
export var _chmoddable = RWXU | RWXG | RWXO | _sss;

const _errors = {
    IO: "Input/output error",
    NOENT: "No such file or directory",
    INVAL: "Invalid argument",
    EXIST: "File exists",
    NAMETOOLONG: "Filename too long",
    NOSPC: "No space left on device",
    NOSYS: "Function not supported",
    ROFS: "ROFLCopter file system",
    NOTDIR: "Not a directory",
    BADF: "Bad file descriptor",
    EXIST: "File exists",
    ISDIR: "Is a directory",
    ACCES: "Permission denied",
    NOSYS: "Function not implemented",
    _TODO: "Not implemented yet!",
};

export var err = {};
Object.keys(_errors).forEach(function (sym) {
    const msg = _errors[sym];
    err[sym] = function () {
        const e = new Error(msg);
        e.code = sym;
        return e;
    };
});
