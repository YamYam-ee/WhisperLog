// Ger röstbibliotekets ONNX Runtime ett eget filnamn.
//
// Problem: Windows 11 har en egen, äldre onnxruntime.dll (1.17) för sina AI-funktioner. Är den
// redan inläst i processen återanvänder Windows den – i stället för WhisperLogs nyare version –
// och sherpa-onnx kraschar ("The requested API version [28] is not available … ORT 1.17.1").
//
// Lösning: kopiera vår onnxruntime.dll till onnxrt-wlog.dll och ändra importnamnet i
// sherpa-onnx-c-api.dll (samma längd, 15 tecken) så att det alltid är vår fil som laddas.
// Körs automatiskt efter npm install och före bygget.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'node_modules', 'sherpa-onnx-win-x64');
const OLD = Buffer.from('onnxruntime.dll', 'ascii');
const NEW = Buffer.from('onnxrt-wlog.dll', 'ascii');
if (OLD.length !== NEW.length) throw new Error('Namnen måste vara lika långa');

if (!fs.existsSync(dir)) {
  console.log('patch-onnx: sherpa-onnx-win-x64 saknas – hoppar över');
  process.exit(0);
}

fs.copyFileSync(path.join(dir, 'onnxruntime.dll'), path.join(dir, 'onnxrt-wlog.dll'));

const api = path.join(dir, 'sherpa-onnx-c-api.dll');
const buf = fs.readFileSync(api);
let replaced = 0;
for (let i = buf.indexOf(OLD); i >= 0; i = buf.indexOf(OLD, i + OLD.length)) {
  NEW.copy(buf, i);
  replaced++;
}
if (replaced) fs.writeFileSync(api, buf);
const already = buf.indexOf(NEW) >= 0;
if (!replaced && !already) throw new Error('patch-onnx: hittade inte importen av onnxruntime.dll i sherpa-onnx-c-api.dll');
console.log(`patch-onnx: ${replaced ? replaced + ' import(er) ändrade' : 'redan ändrad'} – sherpa-onnx använder onnxrt-wlog.dll`);
