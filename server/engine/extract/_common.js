'use strict';

function obs(field, value, method) {
  return { field, value, method };
}

function subject(sourceId, sourceType, observations) {
  const emails = observations.filter((o) => o.field === 'email').map((o) => o.value);
  const phones = observations.filter((o) => o.field === 'phone').map((o) => o.value);
  const names = observations.filter((o) => o.field === 'full_name').map((o) => o.value);
  return {
    sourceId,
    sourceType,
    identity: { emails, phones, names },
    observations,
  };
}

module.exports = { obs, subject };
