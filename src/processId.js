// quick uuid generation
const processId = 'x'.repeat(20).replace(/x/g, () => Math.trunc(Math.random() * 36).toString(36));

module.exports = processId;
