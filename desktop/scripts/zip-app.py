#!/usr/bin/env python3
"""Zip a .app like `ditto -c -k --keepParent`: keeps symlinks as symlinks and unix permissions."""
import os, stat, sys, zipfile
src, out = sys.argv[1].rstrip('/'), sys.argv[2]
base = os.path.dirname(src)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort(); files.sort()
        for name in dirs + files:
            p = os.path.join(root, name); arc = os.path.relpath(p, base)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                zi = zipfile.ZipInfo(arc); zi.create_system = 3
                zi.external_attr = (stat.S_IFLNK | 0o755) << 16
                z.writestr(zi, os.readlink(p), compress_type=zipfile.ZIP_STORED)
                if name in dirs: dirs.remove(name)  # os.walk doesn't follow it anyway
            elif stat.S_ISDIR(st.st_mode):
                zi = zipfile.ZipInfo(arc + '/'); zi.create_system = 3
                zi.external_attr = (stat.S_IFDIR | 0o755) << 16 | 0x10
                z.writestr(zi, b'')
            else:
                zi = zipfile.ZipInfo.from_file(p, arc); zi.create_system = 3
                zi.external_attr = (st.st_mode & 0xFFFF) << 16; zi.compress_type = zipfile.ZIP_DEFLATED
                with open(p, 'rb') as f: z.writestr(zi, f.read(), compresslevel=9)
