#!/usr/bin/env tsx
/**
 * Rebrand script: Transforms happy-coder CLI to @boujot/cli
 *
 * Usage: yarn rebrand
 *
 * ## Git Branch Structure
 *
 * ```
 * main                        ← upstream tracking only (happy branding)
 *     │
 *     └── master              ← boujot development (happy-app rebranded, happy-cli as-is)
 *             │
 *             └── boujot-rebrand-cli-publish  ← CLI npm publishing only
 * ```
 *
 * ## Package Status on master
 *
 * - happy-app → rebranded to boujot-app (for App Store)
 * - happy-cli → stays as happy-coder (this script rebrands for npm)
 * - happy-server → stays as happy-server (private)
 *
 * ## Development Workflow
 *
 * Work on `master` branch (or feature branches off master).
 *
 * ## Adopting Upstream Changes
 *
 * Don't merge - review diffs and apply manually or via LLM:
 * ```bash
 * git fetch origin
 * git diff main@{1.month.ago}..main -- packages/happy-app/sources/
 * # Apply relevant changes to master
 * ```
 *
 * ## Publishing CLI to npm
 *
 * ```bash
 * git checkout boujot-rebrand-cli-publish
 * git reset --hard master
 * yarn rebrand
 * git add bin/ src/ package.json README.md
 * git commit -m "Apply rebrand to @boujot/cli"
 * yarn build
 * npm publish --access public
 * git checkout master
 * ```
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CLI_DIR = join(import.meta.dirname, '..');

// Brand replacements
const OLD_PACKAGE_NAME = 'happy-coder';
const NEW_PACKAGE_NAME = '@boujot/cli';

const OLD_BINARY = 'happy';
const NEW_BINARY = 'boujot';

const OLD_CONFIG_DIR = '.happy';
const NEW_CONFIG_DIR = '.boujot';

/**
 * Replace all occurrences of a pattern in a file
 */
function replaceInFile(filePath: string, replacements: [string | RegExp, string][]): void {
    if (!existsSync(filePath)) {
        console.log(`  ⚠️  File not found: ${filePath}`);
        return;
    }

    let content = readFileSync(filePath, 'utf-8');
    let modified = false;

    for (const [pattern, replacement] of replacements) {
        const newContent = content.replace(pattern, replacement);
        if (newContent !== content) {
            content = newContent;
            modified = true;
        }
    }

    if (modified) {
        writeFileSync(filePath, content, 'utf-8');
        console.log(`  ✓ Updated: ${filePath}`);
    }
}

/**
 * Rename a file if source exists
 */
function renameFile(oldPath: string, newPath: string): void {
    if (existsSync(oldPath)) {
        renameSync(oldPath, newPath);
        console.log(`  ✓ Renamed: ${oldPath} → ${newPath}`);
    } else if (existsSync(newPath)) {
        console.log(`  ✓ Already renamed: ${newPath}`);
    } else {
        console.log(`  ⚠️  Source not found: ${oldPath}`);
    }
}

function main() {
    console.log('\n🔄 Rebranding happy-coder → @boujot/cli\n');

    // 1. Update package.json
    console.log('📦 Updating package.json...');
    const packageJsonPath = join(CLI_DIR, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

    packageJson.name = NEW_PACKAGE_NAME;
    packageJson.bin = {
        [NEW_BINARY]: `./bin/${NEW_BINARY}.mjs`,
        [`${NEW_BINARY}-mcp`]: `./bin/${NEW_BINARY}-mcp.mjs`
    };

    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
    console.log(`  ✓ Updated: package.json`);

    // 2. Rename bin files
    console.log('\n📁 Renaming bin files...');
    renameFile(
        join(CLI_DIR, 'bin', 'happy.mjs'),
        join(CLI_DIR, 'bin', `${NEW_BINARY}.mjs`)
    );
    renameFile(
        join(CLI_DIR, 'bin', 'happy-mcp.mjs'),
        join(CLI_DIR, 'bin', `${NEW_BINARY}-mcp.mjs`)
    );

    // 3. Update configuration.ts - change config directory
    console.log('\n⚙️  Updating configuration path...');
    replaceInFile(join(CLI_DIR, 'src', 'configuration.ts'), [
        [/join\(homedir\(\), '\.happy'\)/g, `join(homedir(), '${NEW_CONFIG_DIR}')`],
        [/'\.happy'/g, `'${NEW_CONFIG_DIR}'`],
    ]);

    // 4. Update help text in source files
    console.log('\n📝 Updating help text...');

    // Files with help text to update
    const helpTextReplacements: [string | RegExp, string][] = [
        // chalk.bold with quotes
        [/\$\{chalk\.bold\('happy'\)\}/g, `\${chalk.bold('${NEW_BINARY}')}`],
        [/\$\{chalk\.bold\('happy /g, `\${chalk.bold('${NEW_BINARY} `],
        [/\$\{chalk\.cyan\('happy /g, `\${chalk.cyan('${NEW_BINARY} `],

        // Multi-line help text - command listings (with proper spacing)
        [/  happy \[options\]/g, `  ${NEW_BINARY} [options]`],
        [/  happy auth /g, `  ${NEW_BINARY} auth `],
        [/  happy codex /g, `  ${NEW_BINARY} codex `],
        [/  happy gemini /g, `  ${NEW_BINARY} gemini `],
        [/  happy connect /g, `  ${NEW_BINARY} connect `],
        [/  happy notify /g, `  ${NEW_BINARY} notify `],
        [/  happy daemon /g, `  ${NEW_BINARY} daemon `],
        [/  happy doctor /g, `  ${NEW_BINARY} doctor `],

        // Single-quoted strings
        [/'happy auth/g, `'${NEW_BINARY} auth`],
        [/'happy connect/g, `'${NEW_BINARY} connect`],
        [/'happy daemon/g, `'${NEW_BINARY} daemon`],
        [/'happy doctor/g, `'${NEW_BINARY} doctor`],
        [/'happy notify/g, `'${NEW_BINARY} notify`],
        [/'happy logout/g, `'${NEW_BINARY} logout`],
        [/'happy gemini/g, `'${NEW_BINARY} gemini`],

        // Double-quoted strings
        [/"happy auth/g, `"${NEW_BINARY} auth`],
        [/"happy connect/g, `"${NEW_BINARY} connect`],
        [/"happy daemon/g, `"${NEW_BINARY} daemon`],
        [/"happy doctor/g, `"${NEW_BINARY} doctor`],
        [/"happy notify/g, `"${NEW_BINARY} notify`],
        [/"happy logout/g, `"${NEW_BINARY} logout`],
        [/"happy gemini/g, `"${NEW_BINARY} gemini`],

        // Examples section (with proper spacing preserved)
        [/  happy                    Start session/g, `  ${NEW_BINARY}                    Start session`],
        [/happy --yolo/g, `${NEW_BINARY} --yolo`],
        [/happy --chrome/g, `${NEW_BINARY} --chrome`],
        [/happy --no-chrome/g, `${NEW_BINARY} --no-chrome`],
        [/happy --js-runtime/g, `${NEW_BINARY} --js-runtime`],
        [/happy --claude-env/g, `${NEW_BINARY} --claude-env`],
        [/happy --resume/g, `${NEW_BINARY} --resume`],
        [/happy sugar for/g, `${NEW_BINARY} sugar for`],

        // CLI supports phrase
        [/Happy supports ALL/g, `Boujot supports ALL`],
        [/flag with happy as/g, `flag with ${NEW_BINARY} as`],

        // Version output
        [/console\.log\(`happy version:/g, `console.log(\`${NEW_BINARY} version:`],

        // Error messages with backticks
        [/run \`happy auth\`/g, `run \`${NEW_BINARY} auth\``],
        [/`happy auth`/g, `\`${NEW_BINARY} auth\``],
        [/`happy doctor clean`/g, `\`${NEW_BINARY} doctor clean\``],

        // Startup and log messages
        [/Starting happy CLI/g, `Starting ${NEW_BINARY} CLI`],
        [/happy directly/g, `${NEW_BINARY} directly`],
        [/const fullCommand = `happy /g, `const fullCommand = \`${NEW_BINARY} `],

        // Usage lines
        [/Usage: happy /g, `Usage: ${NEW_BINARY} `],
    ];

    const sourceFiles = [
        'src/index.ts',
        'src/commands/auth.ts',
        'src/commands/connect.ts',
        'src/api/api.ts',
        'src/utils/serverConnectionErrors.ts',
        'src/utils/serverConnectionErrors.test.ts',
        'src/utils/spawnHappyCLI.ts',
        'src/agent/factories/gemini.ts',
        'src/gemini/runGemini.ts',
        'src/daemon/controlClient.ts',
        'src/daemon/run.ts',
        'src/daemon/daemon.integration.test.ts',
        'src/daemon/CLAUDE.md',
        'src/claude/utils/startHookServer.ts',
    ];

    for (const file of sourceFiles) {
        replaceInFile(join(CLI_DIR, file), helpTextReplacements);
    }

    // 5. Update spawnHappyCLI.ts specifically
    console.log('\n🔧 Updating spawn command...');
    replaceInFile(join(CLI_DIR, 'src/utils/spawnHappyCLI.ts'), [
        [/const fullCommand = `happy /g, `const fullCommand = \`${NEW_BINARY} `],
    ]);

    // 6. Update daemon/run.ts specifically
    replaceInFile(join(CLI_DIR, 'src/daemon/run.ts'), [
        [`'happy directly`, `'${NEW_BINARY} directly`],
    ]);

    // 7. Update integration tests
    replaceInFile(join(CLI_DIR, 'src/daemon/daemon.integration.test.ts'), [
        [`'happy directly`, `'${NEW_BINARY} directly`],
    ]);

    // 8. Update auth.ts QR code messages
    console.log('\n📱 Updating QR code messages...');
    replaceInFile(join(CLI_DIR, 'src/ui/auth.ts'), [
        [/Happy mobile app/g, 'Boujot mobile app'],
    ]);

    // 9. Update README.md for npm
    console.log('\n📄 Updating README.md...');
    replaceInFile(join(CLI_DIR, 'README.md'), [
        [/# Happy\n/g, `# Boujot\n`],
        [/npm install -g happy-coder/g, `npm install -g ${NEW_PACKAGE_NAME}`],
        [/^happy$/gm, NEW_BINARY],
        [/^happy /gm, `${NEW_BINARY} `],
        [/`happy`/g, `\`${NEW_BINARY}\``],
        [/`happy /g, `\`${NEW_BINARY} `],
        [/'happy'/g, `'${NEW_BINARY}'`],
        [/HAPPY_WEBAPP_URL/g, 'BOUJOT_WEBAPP_URL'],
        [/HAPPY_HOME_DIR/g, 'BOUJOT_HOME_DIR'],
        [/~\/\.happy\b/g, `~/${NEW_CONFIG_DIR}`],
        [/happy gemini\b/g, `${NEW_BINARY} gemini`],
        [/Free\. Open source\./g, 'Open source.'],
    ]);

    console.log('\n✅ Rebranding complete!\n');
    console.log('Next steps:');
    console.log('  1. yarn build       # Build the CLI');
    console.log(`  2. node ./bin/${NEW_BINARY}.mjs --help   # Test locally`);
    console.log('  3. npm publish --access public   # Publish to npm\n');
}

main();
