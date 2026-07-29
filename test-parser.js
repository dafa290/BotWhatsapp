const { parseCommands, cleanResponseForWA } = require('./lib/agent-parser');

const samples = [
    {
        name: 'standard run_command',
        input: '```xml\n<run_command>dir</run_command>\n```',
        expectTag: 'run_command',
    },
    {
        name: 'hallucinated command tag',
        input: '<command>dir</command>',
        expectTag: 'run_command',
    },
    {
        name: 'file read self-closing',
        input: '<file action="read" path="index.html" />',
        expectTag: 'read_file',
    },
    {
        name: 'file read paired (must NOT write)',
        input: '<file action="read" path="dym/index.html"></file>',
        expectTag: 'read_file',
    },
    {
        name: 'execute_action nested',
        input: '<execute_action><action type="file_read" path="test.js"/></execute_action>',
        expectTag: 'read_file',
    },
    {
        name: 'write file',
        input: '<file action="create" path="foo.txt">hello world</file>',
        expectTag: 'write_file',
    },
];

let passed = 0;
for (const s of samples) {
    const cmds = parseCommands(s.input);
    const ok = cmds.length > 0 && cmds[0].tag === s.expectTag;
    console.log(ok ? '✓' : '✗', s.name, '→', cmds.map((c) => c.tag).join(', ') || '(none)');
    if (ok) passed++;
}

const leakTest = cleanResponseForWA('Halo!\n<file action="read" path="x"/>\n```xml\n<run_command>dir</run_command>\n```\nSelesai.');
const noXml = !leakTest.includes('<file') && !leakTest.includes('<run_command') && !leakTest.includes('```');
console.log(noXml ? '✓' : '✗', 'cleanResponseForWA strips XML');
if (noXml) passed++;

console.log(`\n${passed}/${samples.length + 1} tests passed`);
process.exit(passed === samples.length + 1 ? 0 : 1);
