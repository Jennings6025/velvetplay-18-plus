function normalizeKenyanPhone(value) {
  const raw = String(value ?? '').replace(/\s+/g, '');
  const compact = raw.replace(/^\+/, '');

  if (!compact) return null;

  if (compact.startsWith('254') && /^254[17]\d{8}$/.test(compact)) {
    return compact;
  }

  if (compact.startsWith('0') && /^0[17]\d{8}$/.test(compact)) {
    return `254${compact.slice(1)}`;
  }

  if (/^[17]\d{8}$/.test(compact)) {
    return `254${compact}`;
  }

  if (/^254[17]\d{8}$/.test(compact)) {
    return compact;
  }

  return null;
}

function isValidKenyanPhone(value) {
  return Boolean(normalizeKenyanPhone(value));
}

module.exports = {
  normalizeKenyanPhone,
  isValidKenyanPhone
};
