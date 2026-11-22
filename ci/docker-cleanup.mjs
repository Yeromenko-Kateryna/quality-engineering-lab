import { requireValid } from './adapters.mjs';

export function projectResources(project, docker) {
  const label = `label=com.docker.compose.project=${project}`;
  return {
    containers: docker(['ps', '-aq', '--no-trunc', '--filter', label]).split(/\r?\n/).filter(Boolean),
    networks: docker(['network', 'ls', '-q', '--no-trunc', '--filter', label]).split(/\r?\n/).filter(Boolean),
  };
}

export function localSutTag(project, docker) {
  const tag = `${project}-sut:latest`;
  const tags = docker(['image', 'ls', '--filter', `reference=${tag}`, '--format', '{{.Repository}}:{{.Tag}}']);
  return tags.split(/\r?\n/).includes(tag) ? tag : null;
}

export function cleanupProject({ project, stage, checkout }, docker) {
  const remaining = projectResources(project, docker);
  const auxiliary = [];
  const scanNetworks = [];
  for (const id of remaining.containers) {
    const data = JSON.parse(docker(['inspect', '--format', '{"name":{{json .Name}},"labels":{{json .Config.Labels}}}', id]));
    const labels = data.labels;
    requireValid(labels?.['com.docker.compose.project'] === project, 'Container project label mismatch');
    if (labels['com.docker.compose.service'] === 'sut') {
      requireValid(data.name === `/${project}-sut-1` && checkout.includes(labels['com.docker.compose.project.working_dir']),
        'SUT is outside the owned checkout');
    } else {
      const ownedAuxiliary = stage === 'performance' ? labels['qel.performance'] === 'search_smoke' &&
        new RegExp(`^/${project}-notebook-[0-9a-f]{32}$`).test(data.name) :
        labels['qel.run'] === project.replace(/-baseline$/, '') &&
        (stage === 'accessibility' ? data.name === `/${project}-browser` : ['gateway', 'zap'].some(name => data.name === `/${project}-${name}`));
      requireValid(ownedAuxiliary, 'Unknown auxiliary container in owned project');
      auxiliary.push(id);
    }
  }
  for (const id of remaining.networks) {
    const net = JSON.parse(docker(['network', 'inspect', '--format', '{{json .}}', id]));
    requireValid(net.Internal && net.Labels?.['com.docker.compose.project'] === project, 'Unexpected network ownership or isolation');
    if (net.Name === `${project}-scan` && stage === 'security' && net.Labels['qel.run'] === project.replace(/-baseline$/, '')) {
      scanNetworks.push(id);
    } else {
      requireValid(net.Name === `${project}_lab` && net.Labels['com.docker.compose.network'] === 'lab', 'Unknown project network');
    }
  }
  for (const id of auxiliary) docker(['rm', '-f', id]);
  for (const id of scanNetworks) docker(['network', 'rm', id]);
  // Compose build tags can point at shared content. Teardown owns containers and networks only.
  if (Object.values(remaining).some(ids => ids.length)) docker(['compose', '-p', project, 'down']);
  requireValid(Object.values(projectResources(project, docker)).every(ids => ids.length === 0), 'Owned resources remain after teardown');
  return localSutTag(project, docker);
}
