import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { CANCELLED_RUN_NOTICE, isUserCancellation } from '../src/services/queryLifecycle';

// Phase 6 is about what the interface says while and after the user acts. The contracts that a
// browser can only show one at a time are pinned here: a stopped run is never reported as a
// failure, every action resolves to exactly one message placed beside its control, a control that
// cannot act says so, and no lifecycle state is claimed that the engine does not actually emit.

const app = fs.readFileSync('src/App.tsx', 'utf-8');
const view = fs.readFileSync('src/components/ResultsView.tsx', 'utf-8');
const input = fs.readFileSync('src/components/QueryInputArea.tsx', 'utf-8');
const sidebar = fs.readFileSync('src/components/Sidebar.tsx', 'utf-8');
const uploader = fs.readFileSync('src/components/CsvUploader.tsx', 'utf-8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));

describe('Interaction polish — a stopped run is not a failed run', () => {
  it('classifies the engine cancellation reason as user intent', () => {
    assert.ok(isUserCancellation('Query cancelled by user'));
    assert.ok(isUserCancellation('Execution canceled by user during validation'));
    assert.ok(!isUserCancellation('Validation failed for metric column'));
    assert.ok(!isUserCancellation('Provider request timed out'));
  });

  it('routes cancellation to a status notice instead of the error alert', () => {
    assert.match(app, /if \(isUserCancellation\(message\)\) \{\s*setRunNotice\(CANCELLED_RUN_NOTICE\);/);
    assert.match(app, /\} else \{\s*console\.error\('Query execution error:', err\);\s*setExecutionError\(message\);/);
    assert.match(app, /role="status"[\s\S]*?border-badge-info-border[\s\S]*?\{runNotice\}/);
    assert.ok(!/role="alert"[\s\S]{0,120}\{runNotice\}/.test(app), 'a cancelled run must not read as an error');
  });

  it('keeps the workspace intact and explains what that means', () => {
    assert.match(CANCELLED_RUN_NOTICE, /Nothing in the workspace changed/);
    assert.ok(
      app.split('setRunNotice(CANCELLED_RUN_NOTICE);').length - 1 === 2,
      'exactly two owners: the Stop button and a cancellation thrown mid-run'
    );
  });

  it('clears the previous notice when a new run starts', () => {
    assert.match(app, /setExecutionError\(null\);\s*setRunNotice\(null\);/);
  });
});

describe('Interaction polish — one message per action, beside the control', () => {
  it('funnels every results action through one transient feedback owner', () => {
    assert.match(view, /const \[actionFeedback, setActionFeedback\] = useState<\{/);
    assert.ok(!/saveFeedback/.test(view), 'the old per-button feedback state is gone');
    const announcements = view.split('announceAction(').length - 1;
    assert.ok(announcements >= 7, `copy, save, remove, both exports and execute all report (${announcements})`);
  });

  it('places each message in the surface that produced it', () => {
    ['answer', 'table', 'sql'].forEach((surface) => {
      assert.ok(
        view.includes(`renderFeedback('${surface}'`),
        `${surface} actions need a line next to their own controls`
      );
    });
    assert.match(view, /announceAction\('CSV download started', 'table'\)/);
    assert.match(view, /announceAction\('Generated SQL copied to clipboard', 'sql'\)/);
    assert.match(view, /'Saved to Sandboxed Memory'/);
    assert.match(
      view,
      /Could not save — the browser refused the storage write\.',\s*'answer',\s*saved \? 'ok' : 'error'/
    );
  });

  it('announces politely once, without a second visible copy', () => {
    assert.strictEqual(view.split('aria-live="polite"').length - 1, 1, 'one polite announcer per result view');
    assert.match(view, /className="sr-only" role="status" aria-live="polite">\s*\{actionFeedback\?\.text \?\? ''\}/);
    assert.ok(!/role="status"[^>]*\{actionFeedback\.text\}/.test(view), 'the visible line must not double-announce');
  });

  it('replaces rather than stacks timers for repeated clicks', () => {
    assert.match(view, /if \(feedbackTimerRef\.current !== null\) window\.clearTimeout\(feedbackTimerRef\.current\);/);
    assert.match(view, /copiedTimerRef\.current = window\.setTimeout/);
    assert.match(
      view,
      /useEffect\(\s*\(\) => \(\) => \{[\s\S]*?clearTimeout\(feedbackTimerRef\.current\)[\s\S]*?clearTimeout\(copiedTimerRef\.current\)/,
      'both timers are cancelled on unmount'
    );
    assert.match(sidebar, /if \(toastTimerRef\.current !== null\) window\.clearTimeout\(toastTimerRef\.current\);/);
    assert.ok(!/setTimeout\(\(\) => setToastStatus\(null\)/.test(sidebar), 'no orphan toast timers remain');
  });

  it('never claims a clipboard write it did not await', () => {
    [view, sidebar].forEach((source, i) => {
      const label = i === 0 ? 'results' : 'sidebar';
      assert.match(source, /await navigator\.clipboard\.writeText/, `${label} must await the write`);
      assert.match(source, /catch/, `${label} must handle a rejected write`);
    });
    assert.match(view, /announceAction\('Clipboard blocked by the browser[^\n]*'sql', 'error'\)/);
    assert.match(sidebar, /showToast\('Clipboard blocked by the browser[^\n]*'error'\)/);
  });

  it('reports a rejected storage write instead of leaving a dead button', () => {
    assert.match(view, /const saved = storage\.saveSuccessfulQuery\(/);
    assert.match(view, /setIsSaved\(saved\);/);
    assert.match(view, /browser refused the storage write/);
  });

  it('tells an export attempt what actually happened', () => {
    assert.match(view, /announceAction\('CSV download started', 'table'\)/);
    assert.match(view, /announceAction\('JSON download started', 'table'\)/);
    assert.match(
      view,
      /disabled=\{result\.rows\.length === 0\}/,
      'exporting an empty result is refused before it is claimed'
    );
  });
});

describe('Interaction polish — loading states stay honest', () => {
  it('renders only the lifecycle states the engine emits', () => {
    ['running', 'waiting', 'done', 'error'].forEach((status) => {
      assert.ok(input.includes(`activeStep.status === '${status}'`), `${status} needs its own indicator`);
    });
  });

  it('never invents progress for an indeterminate run', () => {
    const sources = [app, view, input, sidebar];
    sources.forEach((source, i) => {
      assert.ok(!/% \}/.test(source), `source ${i} must not print a computed percentage`);
      assert.ok(!/aria-valuenow/.test(source), 'no fake progressbar semantics');
    });
    assert.ok(!/role="progressbar"/.test(app + view + input), 'an unbounded run is not a bounded bar');
  });

  it('marks the busy region on the workspace and the edited-SQL control', () => {
    assert.match(app, /aria-busy=\{isRunning\}/);
    assert.match(view, /disabled=\{isExecutingSql\}\s*aria-busy=\{isExecutingSql\}/);
    assert.match(view, /\{isExecutingSql \? 'Executing…' : 'Re-execute SQL'\}/);
  });

  it('stops the spinner from outliving the run', () => {
    assert.match(app, /if \(currentRequestId === queryRequestIdRef\.current\) \{\s*setIsRunning\(false\);\s*setCurrentStep\(null\);/);
    assert.match(input, /\{isRunning && activeStep && \(/, 'the strip only exists while a step is live');
  });
});

describe('Interaction polish — duplicate work is prevented, legitimate work is not', () => {
  it('refuses a second submission while one is running', () => {
    assert.match(app, /if \(!q \|\| !activeDataset \|\| isRunning\) return;/);
    assert.match(input, /const canRun = !isRunning && Boolean\(query\.trim\(\)\) && Boolean\(dataset\);/);
    assert.match(input, /if \(!isRunning && query\.trim\(\) && dataset\) \{\s*onRunQuery\(\);/);
  });

  it('refuses a second parse, edit-run or export click while busy', () => {
    assert.match(uploader, /if \(isLoading\) return;/);
    assert.match(uploader, /disabled=\{isLoading\}/);
    assert.match(view, /if \(isExecutingSql\) return;/);
  });

  it('keeps the block scoped to the action that cannot be repeated', () => {
    assert.match(
      app,
      /A query is still running\. Stop it before re-executing edited SQL\./,
      'the edit-run guard names the reason and the way out'
    );
    assert.match(app, /setRunNotice\('A query is still running/, 'the guard speaks through the status channel');
  });

  it('does not throw away a verified answer when a run is stopped', () => {
    const cancel = app.slice(app.indexOf('const handleCancelQuery'), app.indexOf('// Re-run modified SQL'));
    assert.ok(!/setCurrentResult\(null\)/.test(cancel), 'Stop leaves the previous result standing');
    assert.match(app, /setRunNotice\(CANCELLED_RUN_NOTICE\);\s*\};\s*\n\s*\/\/ Re-run modified SQL/);
  });
});

describe('Interaction polish — controls state their current condition', () => {
  it('shows which way a column is sorted and what the next click does', () => {
    assert.match(view, /const isSorted = sortCol === col;/);
    assert.match(view, /aria-sort=\{sortCol === col \? \(sortAsc \? 'ascending' : 'descending'\) : 'none'\}/);
    assert.match(view, /Sorted ascending\. Sort by \$\{prettifyColumnHeader\(col\)\} descending/);
    assert.match(view, /\{isSorted \? \(\s*sortAsc \? \(\s*<ArrowUp/);
  });

  it('collapses the copy confirmation into the button it confirms', () => {
    assert.match(view, /copiedSql \? \(\s*<>\s*<Check className="w-3\.5 h-3\.5 text-success"/);
    assert.match(view, /aria-label=\{copiedSql \? 'Generated SQL copied to clipboard' : 'Copy generated SQL'\}/);
  });

  it('lets a disabled suggestion chip look disabled', () => {
    assert.match(input, /disabled:opacity-60/);
    const chips = input.slice(input.indexOf('Suggested Query Chips'));
    assert.ok(chips.length > 0, 'the suggestion block still exists');
    assert.ok(!/onMouseEnter=/.test(chips), 'imperative hover styles would override the disabled state');
    assert.ok(!/style=\{\{[\s\S]*?background: 'var\(--surface\)'/.test(chips), 'chips must not carry inline paint');
  });

  it('carries the disclosure state into the label of the disclosure control', () => {
    assert.match(view, /aria-expanded=\{isSqlExpanded\}/);
    assert.match(view, /\{isSqlExpanded \? 'Hide SQL' : 'Show SQL'\}/);
    assert.match(view, /aria-expanded=\{isEditingSql\}/);
    assert.match(view, /\{isEditingSql \? 'Close Editor' : 'Edit SQL'\}/);
    assert.match(view, /aria-expanded=\{isChartOpen\}/);
  });

  it('announces search result counts and offers a way back', () => {
    assert.match(view, /\$\{sortedRows\.length\} of \$\{result\.rows\.length\.toLocaleString\(\)\} rows match/);
    assert.match(view, /No rows match /);
    assert.match(view, /aria-label="Clear row search"/);
  });

  it('advertises the real keyboard shortcut for the platform', () => {
    assert.match(input, /navigator\.platform \|\| navigator\.userAgent/);
    assert.match(input, /aria-keyshortcuts=\{isMac \? 'Meta\+Enter' : 'Control\+Enter'\}/);
    assert.match(input, /\{isMac \? '⌘ Enter' : 'Ctrl Enter'\}/);
    assert.ok(!/>\s*⌘ Enter\s*</.test(input), 'a Mac-only hint is wrong on every other platform');
  });

  it('names the presentation toggle after the state it would leave', () => {
    const header = fs.readFileSync('src/components/Header.tsx', 'utf-8');
    assert.match(header, /aria-label=\{isPresentationMode \? 'Exit Executive View' : 'Presentation view'\}/);
    assert.match(header, /aria-pressed=\{isPresentationMode\}/);
    assert.ok(!/aria-label="Presentation view"/.test(header), 'a fixed name hides which way the toggle currently sits');
  });
});

describe('Interaction polish — state survives the right amount of time', () => {
  it('resets view state for a new question only', () => {
    assert.match(
      view,
      /setSortCol\(null\);\s*setSortAsc\(true\);\s*setIsSqlExpanded\(false\);[\s\S]*?\}, \[result\.id\]\);/
    );
  });

  it('does not close the panel a reader is working in when their edit lands', () => {
    const sqlSync = view.slice(view.indexOf('}, [result.id]);'), view.indexOf('}, [result.sql]);'));
    assert.ok(!/setIsSqlExpanded/.test(sqlSync), 'a re-executed statement keeps its disclosure open');
    assert.match(view, /setEditedSql\(result\.sql\);\s*setIsEditingSql\(false\);/);
  });

  it('keeps no new animation or notification dependency', () => {
    const deps = Object.keys(pkg.dependencies ?? {}).sort();
    assert.ok(!deps.includes('react-hot-toast'), 'no second toast library');
    assert.ok(!deps.includes('framer-motion'), 'no new animation library');
    assert.ok(deps.includes('motion'), 'the pre-existing motion package is untouched');
  });

  it('keeps every transition bound to the existing duration tokens', () => {
    const added = [view, input, sidebar, uploader].filter((source) => /transition-/.test(source)).length;
    assert.ok(added > 0, 'transitions still exist');
    assert.ok(
      ![view, input, sidebar, uploader].some((source) => /transition-[a-z-]*\s*duration-\[[0-9]/.test(source)),
      'no arbitrary millisecond durations'
    );
    assert.match(fs.readFileSync('src/index.css', 'utf-8'), /@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe('Interaction polish — the accepted dialog contract is untouched', () => {
  it('still routes every overlay through the one accessibility hook', () => {
    const hook = fs.readFileSync('src/hooks/useDialogA11y.ts', 'utf-8');
    assert.match(hook, /event\.key === 'Escape'/);
    assert.match(hook, /FOCUSABLE_SELECTOR/);
    assert.match(hook, /opener\.focus\(\)/);
    const users = ['ApiKeyModal', 'OnboardingModal', 'OutOfScopeModal', 'TelemetryAuditorModal', 'Sidebar'];
    users.forEach((name) => {
      const source = fs.readFileSync(`src/components/${name}.tsx`, 'utf-8');
      assert.match(source, /useDialogA11y\(/, `${name} keeps the shared dialog behaviour`);
    });
  });
});
