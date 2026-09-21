import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { checkSample } from '../coordinator/sandbox/check.mjs';

const workflow = async (name) =>
  parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const same = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label} no longer matches the mirrored workflow contract.`);
};

const stagingDeploy = await workflow('deploy-staging.yml');
same(stagingDeploy.name, 'Web Deploy - STAGING', 'staging workflow name');
same(stagingDeploy.on.push.branches, ['1a-staging'], 'staging branches');
same(stagingDeploy.on.push['paths-ignore'], ['ops/**'], 'staging ignored paths');
same(stagingDeploy.concurrency.group, 'staging-deploy', 'staging lock');
same(
  stagingDeploy.jobs['deploy-staging'].name,
  'Deploy exact staging artifact',
  'staging deploy job'
);

const productionDeploy = await workflow('build-upload-deploy-prod.yml');
same(productionDeploy.name, 'Web Deploy - PROD', 'production workflow name');
same(
  Object.keys(productionDeploy.on.workflow_dispatch.inputs),
  ['release_note_opt_out', 'expected_source_sha'],
  'production inputs'
);
same(productionDeploy.concurrency.group, 'web-deploy-prod', 'production lock');
same(
  productionDeploy.jobs['build-upload-deploy'].name,
  'Deploy verified production artifact',
  'production deploy job'
);

const stagingE2e = await workflow('staging-e2e.yml');
same(stagingE2e.name, 'Staging E2E', 'staging E2E workflow name');
same(
  Object.keys(stagingE2e.on.workflow_dispatch.inputs),
  ['pack', 'automatic_deploy_run_id'],
  'staging E2E inputs'
);
same(stagingE2e.concurrency.group, 'staging-e2e', 'staging E2E lock');
same(stagingE2e.jobs['staging-packs'].name, 'Staging E2E packs', 'staging E2E job');

const productionE2e = await workflow('production-e2e.yml');
same(productionE2e.name, 'Production E2E', 'production E2E workflow name');
same(
  Object.keys(productionE2e.on.workflow_dispatch.inputs),
  ['automatic_deploy_run_id', 'scope'],
  'production E2E inputs'
);
same(productionE2e.concurrency.group, 'production-e2e', 'production E2E lock');
same(
  productionE2e.jobs.readonly.name,
  'Production read-only E2E packs',
  'production E2E job'
);

for (const [name, expected] of [
  ['staging-e2e-dispatch.yml', ['Staging E2E Dispatch', 'Web Deploy - STAGING', '1a-staging']],
  ['production-e2e-dispatch.yml', ['Production E2E Dispatch', 'Web Deploy - PROD', 'main']]
]) {
  const dispatch = await workflow(name);
  same(dispatch.name, expected[0], `${name} name`);
  same(dispatch.on.workflow_run.workflows, [expected[1]], `${name} source workflow`);
  same(dispatch.on.workflow_run.branches, [expected[2]], `${name} source branch`);
}

await checkSample('frontend');
