'use strict';

function detect(source) {
  if (source.type) return source.type;
  const name = (source.name || '').toLowerCase();
  const content = typeof source.content === 'string' ? source.content.trim() : '';

  const isBareGithubUrl =
    content.length < 120 && /^(https?:\/\/)?(www\.)?github\.com\/[^\s]+$/i.test(content);
  const looksGithubBlob =
    /github/.test(name) ||
    /"login"\s*:/.test(content) ||
    /"public_repos"\s*:/.test(content) ||
    isBareGithubUrl;

  const isBareLinkedinUrl =
    content.length < 160 && /^(https?:\/\/)?(www\.)?linkedin\.com\/[^\s]+$/i.test(content);
  const looksLinkedin =
    /linkedin/.test(name) ||
    /"(publicProfileUrl|vanityUrl|profileUrl)"\s*:/.test(content) ||
    isBareLinkedinUrl;

  // resume: by filename, or by plain text carrying resume-style section headings
  if (/\.(pdf|docx)$/.test(name) || /\b(resume|cv)\b/.test(name.replace(/\.[a-z]+$/, ''))) return 'resume';
  const looksResume =
    !content.startsWith('{') && !content.startsWith('[') &&
    /^(work\s+)?(experience|employment|professional\s+experience)\s*:?$/im.test(content) &&
    /^education\s*:?$/im.test(content);
  if (looksResume) return 'resume';

  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.txt')) return 'notes';
  if (looksGithubBlob) return 'github';
  if (looksLinkedin) return 'linkedin';
  if (name.endsWith('.json')) return 'ats';

  if (content.startsWith('{') || content.startsWith('[')) return 'ats';
  if (content.includes(',') && /\n/.test(content) && /(name|email|phone)/i.test(content.split('\n')[0])) {
    return 'csv';
  }
  if (content.length > 0) return 'notes';

  return 'unknown';
}

module.exports = { detect };
