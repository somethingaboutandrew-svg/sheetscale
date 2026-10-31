/* SheetScale qpdf worker. Runs qpdf (WebAssembly) entirely inside the browser. */
importScripts('qpdf.js');
self.onmessage = async (e) => {
  const { id, input, args, back } = e.data;
  let out = '';
  let err = '';
  try {
    const q = await Module({
      locateFile: (p) => (p.endsWith('.wasm') ? new URL('qpdf.wasm', self.location.href).href : p),
      print: (t) => { out += t + '\n'; },
      printErr: (t) => { err += t + '\n'; },
      noInitialRun: true,
    });
    q.FS.writeFile('/in.pdf', input);
    let code = 0;
    try {
      code = q.callMain(args.map((a) => (a === '@IN' ? '/in.pdf' : a === '@OUT' ? '/out.pdf' : a)));
    } catch (x) {
      code = x && typeof x.status === 'number' ? x.status : -1;
      if (code === -1) err += String(x);
    }
    let output = null;
    try { output = q.FS.readFile('/out.pdf'); } catch (_) { /* no output */ }
    try { q.FS.unlink('/in.pdf'); q.FS.unlink('/out.pdf'); } catch (_) { /* ignore */ }
    const tr = output ? [output.buffer] : [];
    if (back) tr.push(input.buffer);
    self.postMessage({ id, code, output, input: back ? input : undefined, out, err }, tr);
  } catch (x) {
    self.postMessage({ id, code: -1, output: null, input: back ? input : undefined, out, err: err + String(x) }, back ? [input.buffer] : []);
  }
};
