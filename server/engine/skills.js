'use strict';

const CANON = {
  JavaScript: ['js', 'javascript', 'java script', 'ecmascript', 'es6', 'es2015'],
  TypeScript: ['ts', 'typescript', 'type script'],
  'Node.js': ['node', 'nodejs', 'node js', 'node.js'],
  React: ['react', 'reactjs', 'react.js', 'react js'],
  'Vue.js': ['vue', 'vuejs', 'vue.js'],
  Angular: ['angular', 'angularjs', 'angular.js'],
  Python: ['python', 'py', 'python3'],
  Java: ['java', 'core java', 'java se'],
  'C++': ['c++', 'cpp', 'cplusplus'],
  'C#': ['c#', 'csharp', 'c sharp'],
  Go: ['go', 'golang'],
  Rust: ['rust', 'rust-lang'],
  SQL: ['sql', 'structured query language'],
  PostgreSQL: ['postgres', 'postgresql', 'psql'],
  MySQL: ['mysql'],
  MongoDB: ['mongo', 'mongodb'],
  Docker: ['docker', 'dockerized', 'containerization'],
  Kubernetes: ['k8s', 'kubernetes', 'kube'],
  AWS: ['aws', 'amazon web services'],
  GCP: ['gcp', 'google cloud', 'google cloud platform'],
  Azure: ['azure', 'microsoft azure'],
  GraphQL: ['graphql', 'graph ql'],
  REST: ['rest', 'restful', 'rest api', 'rest apis'],
  'Machine Learning': ['ml', 'machine learning', 'machine-learning'],
  'Deep Learning': ['dl', 'deep learning'],
  TensorFlow: ['tensorflow', 'tf'],
  PyTorch: ['pytorch', 'torch'],
  Git: ['git', 'github', 'version control'],
  'CI/CD': ['ci/cd', 'cicd', 'ci cd', 'continuous integration'],
  HTML: ['html', 'html5'],
  CSS: ['css', 'css3'],
  Redis: ['redis'],
  Kafka: ['kafka', 'apache kafka'],
  'Spring Boot': ['spring', 'spring boot', 'springboot'],
  Django: ['django'],
  Flask: ['flask'],
  Express: ['express', 'expressjs', 'express.js'],
};

const ALIAS_TO_CANON = (() => {
  const map = new Map();
  for (const [canonical, aliases] of Object.entries(CANON)) {
    map.set(canonical.toLowerCase(), canonical);
    for (const a of aliases) map.set(a.toLowerCase(), canonical);
  }
  return map;
})();

function normalizeKey(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(raw) {
  return String(raw)
    .trim()
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function canonicalizeSkill(raw) {
  if (raw == null) return null;
  const key = normalizeKey(raw);
  if (!key || key.length > 60) return null;
  const hit = ALIAS_TO_CANON.get(key);
  if (hit) return { name: hit, known: true };
  return { name: titleCase(key), known: false };
}

module.exports = { canonicalizeSkill, CANON };
