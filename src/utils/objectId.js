// Strict 24-hex check (mongoose's isValid also accepts any 12-char string).
const isObjectId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);

module.exports = { isObjectId };
