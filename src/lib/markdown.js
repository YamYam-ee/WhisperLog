// Markdown → HTML (visning/PDF) och Markdown → Word (.docx).
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
} from 'docx';

marked.setOptions({ gfm: true, breaks: false });

export function mdToHtml(md) {
  return DOMPurify.sanitize(marked.parse(md || ''));
}

const PRINT_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 11pt; color: #111; line-height: 1.45; }
  h1 { font-size: 20pt; margin: 0 0 8pt; } h2 { font-size: 14pt; margin: 16pt 0 6pt; border-bottom: 1px solid #ccc; padding-bottom: 2pt; }
  h3 { font-size: 12pt; margin: 12pt 0 4pt; } p { margin: 0 0 7pt; } ul, ol { margin: 0 0 7pt 18pt; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; } th, td { border: 1px solid #999; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background: #eee; } blockquote { margin: 0 0 8pt; padding-left: 10pt; border-left: 3px solid #ccc; color: #444; }
  code { font-family: Consolas, monospace; } hr { border: 0; border-top: 1px solid #ccc; margin: 12pt 0; }`;

export function mdToPrintHtml(md, title) {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>${title || 'Protokoll'}</title><style>${PRINT_CSS}</style></head><body>${mdToHtml(md)}</body></html>`;
}

function decode(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function inline(tokens = [], style = {}) {
  const runs = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'strong':
        runs.push(...inline(t.tokens, { ...style, bold: true }));
        break;
      case 'em':
        runs.push(...inline(t.tokens, { ...style, italics: true }));
        break;
      case 'del':
        runs.push(...inline(t.tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        runs.push(new TextRun({ text: decode(t.text), font: 'Consolas', ...style }));
        break;
      case 'br':
        runs.push(new TextRun({ text: '', break: 1 }));
        break;
      case 'link':
        runs.push(...inline(t.tokens, { ...style, underline: {} }));
        break;
      case 'text':
        if (t.tokens?.length) runs.push(...inline(t.tokens, style));
        else runs.push(new TextRun({ text: decode(t.text), ...style }));
        break;
      default:
        runs.push(new TextRun({ text: decode(t.text ?? t.raw ?? ''), ...style }));
    }
  }
  return runs;
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: '999999' };

function blocks(tokens, ctx = {}) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[t.depth - 1], children: inline(t.tokens), spacing: { before: 240, after: 120 } }));
        break;
      case 'paragraph':
        out.push(new Paragraph({ children: inline(t.tokens), spacing: { after: 120 }, indent: ctx.indent ? { left: ctx.indent } : undefined }));
        break;
      case 'list': {
        const level = ctx.listLevel ?? 0;
        t.items.forEach((item, i) => {
          const prefix = t.ordered ? `${(Number(t.start) || 1) + i}. ` : '';
          let first = true;
          for (const child of item.tokens) {
            if (child.type === 'list') {
              out.push(...blocks([child], { ...ctx, listLevel: level + 1 }));
            } else if (child.type === 'text' || child.type === 'paragraph') {
              const check = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
              const children = [new TextRun(first ? prefix + check : ''), ...inline(child.tokens || [child])];
              out.push(
                t.ordered
                  ? new Paragraph({ children, indent: { left: 360 * (level + 1), hanging: 260 }, spacing: { after: 60 } })
                  : new Paragraph({ children, bullet: { level }, spacing: { after: 60 } })
              );
              first = false;
            } else out.push(...blocks([child], ctx));
          }
        });
        break;
      }
      case 'table': {
        const cell = (c, header) =>
          new TableCell({
            children: [new Paragraph({ children: inline(c.tokens, header ? { bold: true } : {}) })],
            shading: header ? { type: ShadingType.CLEAR, fill: 'EEEEEE', color: 'auto' } : undefined,
            borders: { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder },
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
          });
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }), ...t.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) }))],
          })
        );
        out.push(new Paragraph({ text: '' }));
        break;
      }
      case 'blockquote':
        out.push(...blocks(t.tokens, { ...ctx, indent: (ctx.indent || 0) + 400 }));
        break;
      case 'code':
        for (const line of t.text.split('\n')) out.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas', size: 20 })] }));
        break;
      case 'hr':
        out.push(new Paragraph({ text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } }, spacing: { after: 160 } }));
        break;
      case 'space':
        break;
      default:
        if (t.tokens) out.push(new Paragraph({ children: inline(t.tokens) }));
        else if (t.text) out.push(new Paragraph({ text: decode(t.text) }));
    }
  }
  return out;
}

export async function mdToDocx(md) {
  const doc = new Document({
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
    },
    sections: [{ properties: {}, children: blocks(marked.lexer(md || '')) }],
  });
  const blob = await Packer.toBlob(doc);
  return blob.arrayBuffer();
}
