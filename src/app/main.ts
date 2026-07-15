// Entry point: mount the app shell (specs/app-shell-navigation.md). TITLE renders with zero
// data dependency; bootstrap and audio unlock are handled inside bootShell.

import { bootShell } from './shell';

const mount = document.getElementById('app');
if (mount === null) {
  throw new Error('#app mount point missing');
}
bootShell(mount);
