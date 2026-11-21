// A faster drop-in for make.fun's csv-reader 1.0.0.
//
// The reference builds every field a character at a time and allocates an object per field.
// This reader scans once from left to right, taking whole slices between commas, quotes and
// line breaks; it only builds pieces for the rare fields that need rewriting (doubled
// quotes, CRs, stray CRs, trailing junk). Broken-row policy, error order and line numbers
// are exactly csv-reader 1.0.0's.

const COMMA = 1;
const LINE_BREAK = 2;
const END = 3;

/** csv-reader's answer for one {text, header} case: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0; // drop a leading BOM
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Unquoted text from `pos` to the next comma or line break. `value` is a prefix already
  // gathered (a quoted field plus junk, or the literal quote of an unterminated field).
  // `kept` counts the characters this call keeps, which decides quote_junk.
  function unquoted(value) {
    const start = pos;
    let i = start;
    let pieces = null;
    let pieceStart = start;
    let kept = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44 || c === 10 || (c === 13 && text.charCodeAt(i + 1) === 10)) {
        const tail = text.slice(pieceStart, i);
        kept += i - pieceStart;
        let ended;
        if (c === 44) {
          pos = i + 1;
          ended = COMMA;
        } else {
          pos = c === 10 ? i + 1 : i + 2;
          line++;
          ended = LINE_BREAK;
        }
        if (pieces === null) return { value: value + tail, ended, kept };
        pieces.push(tail);
        return { value: value + pieces.join(''), ended, kept };
      }
      if (c === 13) {
        // A lone CR outside quotes is dropped with a stray_cr error.
        err('stray_cr');
        if (pieces === null) pieces = [];
        pieces.push(text.slice(pieceStart, i));
        kept += i - pieceStart;
        i++;
        pieceStart = i;
        continue;
      }
      i++;
    }
    const tail = text.slice(pieceStart, n);
    kept += n - pieceStart;
    pos = n;
    if (pieces === null) return { value: value + tail, ended: END, kept };
    pieces.push(tail);
    return { value: value + pieces.join(''), ended: END, kept };
  }

  // A field opening with a quote at `pos`, including any junk that follows its close.
  function quoted() {
    const open = pos;
    const openLine = line;
    const start = pos + 1;
    let p = start;
    let pieces = null;
    let pieceStart = start;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 34) {
        if (text.charCodeAt(p + 1) === 34) {
          // "" inside the field is one literal quote: keep it inside the slice.
          if (pieces === null) pieces = [];
          pieces.push(text.slice(pieceStart, p + 1));
          p += 2;
          pieceStart = p;
          continue;
        }
        const tail = text.slice(pieceStart, p);
        const value = pieces === null ? tail : (pieces.push(tail), pieces.join(''));
        pos = p + 1;
        if (pos >= n) return { value, ended: END };
        const d = text.charCodeAt(pos);
        if (d === 44) {
          pos++;
          return { value, ended: COMMA };
        }
        if (d === 10) {
          pos++;
          line++;
          return { value, ended: LINE_BREAK };
        }
        if (d === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line++;
          return { value, ended: LINE_BREAK };
        }
        // Text after the closing quote is appended verbatim; its kept length decides
        // whether the field reports quote_junk.
        const junk = unquoted(value);
        if (junk.kept > 0) err('quote_junk');
        return junk;
      }
      if (c === 13) {
        // CRLF and a lone CR inside a quoted field are each read as one LF.
        if (pieces === null) pieces = [];
        pieces.push(text.slice(pieceStart, p));
        pieces.push('\n');
        line++;
        p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
        pieceStart = p;
        continue;
      }
      if (c === 10) line++;
      p++;
    }
    // The quote never closes: it is a literal character and the text after it is read
    // again as unquoted, with the line count restarted at the opening quote's line.
    pos = open + 1;
    line = openLine;
    err('unterminated_quote');
    return unquoted('"');
  }

  while (true) {
    // A line holding no characters is no record.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let isQuoted = false;
    let value;
    let ended;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        isQuoted = true;
        const f = quoted();
        value = f.value;
        ended = f.ended;
      } else {
        isQuoted = false;
        const start = pos;
        let i = start;
        let c = 0;
        while (i < n) {
          c = text.charCodeAt(i);
          if (c === 44 || c === 10 || c === 13) break;
          i++;
        }
        if (i < n && c === 13 && text.charCodeAt(i + 1) !== 10) {
          pos = start;
          const f = unquoted('');
          value = f.value;
          ended = f.ended;
        } else {
          value = i === start ? '' : text.slice(start, i);
          if (i >= n) {
            pos = n;
            ended = END;
          } else if (c === 44) {
            pos = i + 1;
            ended = COMMA;
          } else {
            pos = c === 10 ? i + 1 : i + 2;
            line++;
            ended = LINE_BREAK;
          }
        }
      }
      fields.push(value);
      if (ended !== COMMA) break;
    }

    // A lone unquoted empty field is no record; stray_cr errors from it stay.
    if (fields.length === 1 && fields[0] === '' && !isQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      err('short_row');
      errors[errors.length - 1].fields = fields.length;
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      err('long_row');
      errors[errors.length - 1].extra = fields.splice(width);
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
