// One CSV cell: quoted, and a leading = + - @ (or tab/CR) neutralised so a
// name like "=HYPERLINK(...)" cannot run as a formula when the export is opened
// in a spreadsheet.
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

module.exports = { csvCell };
