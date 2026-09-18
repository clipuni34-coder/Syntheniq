#!/usr/bin/env python3
"""Generator: rebuilds tools/reapply8.py from the current (fixed) tree."""
import json

ROOT = '/home/user/Syntheniq'
openai_ts = open(f'{ROOT}/apps/api/src/ai/openai.ts').read()
test_mjs = open(f'{ROOT}/apps/api/test/openai-client.mjs').read()
server_ts = open(f'{ROOT}/apps/api/src/server.ts').read()

listen_line = "app.listen({ port: PORT, host: '0.0.0.0' });"
idx = server_ts.index('// \u2500\u2500 startup reconcile (crash-consistency)')
reconcile_block = server_ts[idx:server_ts.index(listen_line)]

old_jobs = (
    "  // Resume guard: a job left \"running\" by a crash can RESUME from the last\n"
    "  // completed stage (intermediate artifacts are persisted on disk).\n"
    "  if (state.status === 'running' || state.status === 'cancelling') {\n"
    "    state.status = 'interrupted';\n"
    "    state.error = 'interrupted by server restart \u2014 retry resumes from the last completed stage';\n"
    "  }\n"
)
new_jobs = (
    "  // NOTE: crash handling for jobs left 'running' by a dead server is\n"
    "  // centralized in server.ts startup reconcile. No per-load stamping here \u2014\n"
    "  // it misfired on fresh uploads whose job legitimately starts running.\n"
)

tpl = '''#!/usr/bin/env python3
"""reapply8 \u2014 the fixes that postdate reapply1-7 (lost again in reset #21):
  1. openai.ts  \u2014 live-verified OpenAI Responses API contract
     (json_object not json, lowercase-json input guard, per-model
      temperature auto-learning). Full-file write.
  2. test/openai-client.mjs \u2014 the 14/14 contract test (mocked fetch).
  3. server.ts  \u2014 startup reconcile: orphaned running/cancelling jobs \u2192
     'interrupted' once at boot (crash-consistency).
  4. jobs.ts    \u2014 hydrateJob no longer stamps interrupted per-load
     (it misfired on fresh uploads).
Idempotent: full-file writes compare content; patches assert anchors.
"""
import os, sys

ROOT = '/home/user/Syntheniq'

def patch(path, old, new, tag):
    p = os.path.join(ROOT, path)
    s = open(p).read()
    if new in s:
        print(f'  = {tag} (already applied)')
        return
    if old not in s:
        print(f'  ! {tag} ANCHOR MISSING \u2014 inspect {path}')
        sys.exit(1)
    s = s.replace(old, new, 1)
    open(p, 'w').write(s)
    print(f'  + {tag}')

def write(path, content, tag):
    p = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if os.path.exists(p) and open(p).read() == content:
        print(f'  = {tag} (unchanged)')
        return
    open(p, 'w').write(content)
    print(f'  + {tag} (written)')

write('apps/api/src/ai/openai.ts', OPENAI_TS, 'openai.ts: live-verified API contract')
write('apps/api/test/openai-client.mjs', OPENAI_TEST, 'test/openai-client.mjs (14/14 contract test)')
patch('apps/api/src/server.ts', LISTEN, RECONCILE + LISTEN, 'server.ts: startup reconcile')
patch('apps/api/src/jobs.ts', OLD_JOBS, NEW_JOBS, 'jobs.ts: hydrateJob guard removed')
print('reapply8: OK')
'''

out = tpl.replace('OPENAI_TS', json.dumps(openai_ts))
out = out.replace('OPENAI_TEST', json.dumps(test_mjs))
out = out.replace('LISTEN', json.dumps(listen_line))
out = out.replace('RECONCILE', json.dumps(reconcile_block))
out = out.replace('OLD_JOBS', json.dumps(old_jobs))
out = out.replace('NEW_JOBS', json.dumps(new_jobs))
open(f'{ROOT}/tools/reapply8.py', 'w').write(out)
print('reapply8.py regenerated:', len(out), 'bytes')
