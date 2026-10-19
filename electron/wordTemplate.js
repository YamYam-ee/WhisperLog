// Fyller ett tidigare protokoll i Word (.docx) med nytt innehåll så att mallens sidhuvud,
// sidfot, loggor, typsnitt, marginaler och formatmallar följer med.
//
// Innehållet (rubriker, stycken, listor, tabeller) kommer från ett docx som renderer byggt
// ur Markdown. Det läggs in i mallens dokument i stället för mallens gamla text. Bilder
// (t.ex. logga) överst i mallens brödtext behålls.
const fs = require('fs');
const JSZip = require('jszip');

// Delar w:body i toppnivåblock (w:p, w:tbl, w:sdt) utan att tappa nästlade element.
function topLevelBlocks(body) {
  const blocks = [];
  const re = /<(\/?)w:(p|tbl|sdt)\b[^>]*?(\/?)>/g;
  let depth = 0;
  let start = -1;
  let m;
  while ((m = re.exec(body))) {
    const closing = m[1] === '/';
    const selfClosing = m[3] === '/';
    if (!closing && !selfClosing) {
      if (depth === 0) start = m.index;
      depth++;
    } else if (closing) {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(body.slice(start, re.lastIndex));
        start = -1;
      }
    } else if (selfClosing && depth === 0) {
      blocks.push(m[0]);
    }
  }
  return blocks;
}

const hasText = (xml) => /<w:t[ >][^<]*\S[^<]*<\/w:t>/.test(xml);
const hasImage = (xml) => /<w:drawing|<w:pict|<v:imagedata/.test(xml);

// styleId för de inbyggda formatmallarna ("heading 1" heter t.ex. "Rubrik1" i svenska Word).
function styleIds(stylesXml) {
  const map = {};
  const re = /<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<w:name w:val="([^"]+)"/g;
  let m;
  while ((m = re.exec(stylesXml))) map[m[2].toLowerCase()] = m[1];
  return map;
}

async function fillTemplate(templatePath, generatedDocx) {
  const tpl = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const gen = await JSZip.loadAsync(Buffer.from(generatedDocx));
  const tDoc = await tpl.file('word/document.xml').async('string');
  const gDoc = await gen.file('word/document.xml').async('string');

  const tBodyMatch = tDoc.match(/<w:body>([\s\S]*)<\/w:body>/);
  const gBodyMatch = gDoc.match(/<w:body>([\s\S]*)<\/w:body>/);
  if (!tBodyMatch || !gBodyMatch) throw new Error('Kunde inte läsa Word-mallen');

  // Mallens sektionsinställningar (sidhuvud/sidfot, marginaler) ska vara kvar sist i dokumentet.
  const tBody = tBodyMatch[1];
  const sectPr = (tBody.match(/<w:sectPr\b[\s\S]*<\/w:sectPr>\s*$/) || [''])[0];

  // Behåll logotyper överst i mallens brödtext (bildstycken innan första textstycket).
  const keep = [];
  for (const block of topLevelBlocks(tBody.replace(sectPr, ''))) {
    if (hasImage(block) && !hasText(block)) keep.push(block);
    else if (hasText(block)) break;
  }

  // Nytt innehåll – utan den genererade sektionen, och med mallens namn på formatmallarna.
  let content = gBodyMatch[1].replace(/<w:sectPr\b[\s\S]*<\/w:sectPr>\s*$/, '');
  const styles = tpl.file('word/styles.xml') ? styleIds(await tpl.file('word/styles.xml').async('string')) : {};
  for (const [genId, name] of [
    ['Heading1', 'heading 1'],
    ['Heading2', 'heading 2'],
    ['Heading3', 'heading 3'],
    ['Heading4', 'heading 4'],
    ['Title', 'title'],
  ]) {
    if (styles[name] && styles[name] !== genId) content = content.split(`w:val="${genId}"`).join(`w:val="${styles[name]}"`);
  }

  const newDoc = tDoc.replace(tBodyMatch[0], `<w:body>${keep.join('')}${content}${sectPr}</w:body>`);
  tpl.file('word/document.xml', newDoc);
  return tpl.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { fillTemplate, topLevelBlocks };
