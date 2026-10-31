#!/usr/bin/env python3
"""Independent check of ad-hoc code signatures in a .app (no macOS needed).
For every Mach-O: finds the embedded CodeDirectory and recomputes each code-page hash,
plus the Info.plist (slot -1) and CodeResources (slot -3) special hashes for bundle mains."""
import hashlib, os, struct, sys

def be(b, o, n=4): return int.from_bytes(b[o:o+n], 'big')

def slices(data):
    m = data[:4]
    if m == b'\xca\xfe\xba\xbe':  # fat
        n = be(data, 4); out = []
        for i in range(n):
            off, size = be(data, 8+i*20+8), be(data, 8+i*20+12); out.append((off, data[off:off+size]))
        return out
    return [(0, data)]

def check_slice(buf, bundle_files):
    if buf[:4] != b'\xcf\xfa\xed\xfe': return 'not-macho64'
    ncmds = struct.unpack_from('<I', buf, 16)[0]; off = 32; sig = None
    for _ in range(ncmds):
        cmd, sz = struct.unpack_from('<II', buf, off)
        if cmd == 0x1d: sig = struct.unpack_from('<II', buf, off+8)
        off += sz
    if not sig: return 'UNSIGNED'
    so, ss = sig; sb = buf[so:so+ss]
    assert be(sb, 0) == 0xfade0cc0
    count = be(sb, 8); cd = None
    for i in range(count):
        typ, o = be(sb, 12+i*8), be(sb, 16+i*8)
        if typ == 0 and be(sb, o) == 0xfade0c02: cd = sb[o:]
    if cd is None: return 'NO-CODEDIR'
    flags = be(cd, 12); hashOff = be(cd, 16); nSpecial = be(cd, 24); nCode = be(cd, 28)
    codeLimit = be(cd, 32); hsize = cd[36]; htype = cd[37]; pshift = cd[39]
    h = hashlib.sha256 if htype == 2 else hashlib.sha1
    assert codeLimit == so, f'codeLimit {codeLimit} != sig offset {so}'
    page = 1 << pshift
    for i in range(nCode):
        chunk = buf[i*page:min((i+1)*page, codeLimit)]
        if h(chunk).digest()[:hsize] != cd[hashOff+i*hsize:hashOff+(i+1)*hsize]: return f'PAGE {i} MISMATCH'
    for slot, f in ((1, 'Info.plist'), (3, 'CodeResources')):
        if nSpecial >= slot and f in bundle_files:
            exp = cd[hashOff-slot*hsize:hashOff-(slot-1)*hsize]
            if exp != b'\0'*hsize and h(open(bundle_files[f], 'rb').read()).digest()[:hsize] != exp: return f'{f} HASH MISMATCH'
    return 'ok adhoc' if flags & 0x2 else f'ok flags={flags:#x}'

def bundle_of(path):
    p = path
    while p != '/':
        p = os.path.dirname(p)
        if p.endswith(('.app', '.framework')):
            c = os.path.join(p, 'Contents') if p.endswith('.app') else os.path.join(p, 'Versions', 'A')
            res = os.path.join(c, 'Resources') if p.endswith('.framework') else c
            files = {'Info.plist': os.path.join(res if p.endswith('.framework') else c, 'Info.plist'),
                     'CodeResources': os.path.join(c, '_CodeSignature', 'CodeResources')}
            exe_dir = c if p.endswith('.framework') else os.path.join(c, 'MacOS')
            return files, exe_dir
    return {}, None

bad = 0; total = 0
for root, _, fs in os.walk(sys.argv[1]):
    for f in fs:
        p = os.path.join(root, f)
        if os.path.islink(p): continue
        data = open(p, 'rb').read()
        if data[:4] not in (b'\xca\xfe\xba\xbe', b'\xcf\xfa\xed\xfe'): continue
        bf, exe_dir = bundle_of(p)
        main = exe_dir and os.path.dirname(p) == exe_dir
        res = [check_slice(s, bf if main else {}) for _, s in slices(data)]
        total += 1
        if any(not r.startswith('ok') for r in res): bad += 1
        print(f'{"/".join(res):12s} {os.path.relpath(p, sys.argv[1])}')
print(f'{total} Mach-O files, {bad} problems'); sys.exit(1 if bad else 0)
