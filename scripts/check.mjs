import { readFile } from 'node:fs/promises';
import { checkSample } from '../coordinator/sandbox/check.mjs';

const contracts = {
  'deploy-staging.yml': [
    'name: Web Deploy - STAGING',
    'group: staging-deploy',
    'name: Deploy exact staging artifact'
  ],
  'build-upload-deploy-prod.yml': [
    'name: Web Deploy - PROD',
    'release_note_opt_out:',
    'expected_source_sha:',
    'group: web-deploy-prod',
    'name: Deploy verified production artifact'
  ],
  'staging-e2e.yml': [
    'name: Staging E2E',
    'automatic_deploy_run_id:',
    'group: staging-e2e',
    'name: Staging E2E packs'
  ],
  'production-e2e.yml': [
    'name: Production E2E',
    'automatic_deploy_run_id:',
    'group: production-e2e',
    'name: Production read-only E2E packs'
  ],
  'staging-e2e-dispatch.yml': ['name: Staging E2E Dispatch'],
  'production-e2e-dispatch.yml': ['name: Production E2E Dispatch']
};

for (const [name, required] of Object.entries(contracts)) {
  const workflow = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  for (const text of required) {
    if (!workflow.includes(text))
      throw new Error(`${name} no longer mirrors required contract text: ${text}`);
  }
}

await checkSample('frontend');
