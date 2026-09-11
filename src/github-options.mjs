export function parseGithubCli(argv) {
  const args = [...argv];
  const out = {
    command: 'github',
    subcommand: args[0] || '',
    repo: '',
    issue: '',
    dryRun: false,
    fixture: '',
    help: false,
  };
  if (args[0] === 'issue' && (args[1] === 'run' || args[1] === 'inspect')) {
    out.subcommand = `issue ${args[1]}`;
    parseFlags(args.slice(2), out);
  } else if (args[0] === 'labels' && args[1] === 'setup') {
    out.subcommand = 'labels setup';
    parseFlags(args.slice(2), out);
  } else if (args[0] === 'status' || args[0] === 'resume' || args[0] === 'simulate' || args[0] === 'doctor' || args[0] === 'authorize') {
    out.subcommand = args[0];
    parseFlags(args.slice(1), out);
  } else if (args[0] === '--help' || args[0] === '-h' || !args[0]) {
    out.help = true;
  } else {
    out.error = `Unknown github subcommand: ${args.join(' ')}`;
  }
  return out;
}

function parseFlags(args, out) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo') out.repo = args[++i] ?? '';
    else if (a === '--issue') out.issue = args[++i] ?? '';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--fixture') out.fixture = args[++i] ?? '';
    else if (a === '--help' || a === '-h') out.help = true;
  }
}

export function githubHelpText() {
  return [
    'GitHub automation (optional, default off):',
    '',
    '  ai-orchestrator github issue run --repo owner/name --issue 42 [--dry-run]',
    '  ai-orchestrator github issue inspect --repo owner/name --issue 42',
    '  ai-orchestrator github labels setup --repo owner/name [--dry-run]',
    '  ai-orchestrator github status --repo owner/name --issue 42',
    '  ai-orchestrator github authorize --repo owner/name --issue 42',
    '  ai-orchestrator github doctor [--repo owner/name]',
    '  ai-orchestrator github resume --repo owner/name --issue 42 [--dry-run]',
    '  ai-orchestrator github simulate --fixture path.json',
    '',
    'Automation starts only after a trusted actor adds the ai-auto label.',
    'v1.1 never auto-merges or publishes.',
  ].join('\n');
}
