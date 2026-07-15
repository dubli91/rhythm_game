import { Application, Graphics, Text } from 'pixi.js';

// Milestone 0 smoke test: prove the PixiJS/WebGL pipeline boots and draws at the
// game's logical resolution. Replaced by the real app shell + screen state machine
// in Milestone 2 (specs/app-shell-navigation.md).

const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;

async function boot(): Promise<void> {
  const app = new Application();
  await app.init({
    width: LOGICAL_WIDTH,
    height: LOGICAL_HEIGHT,
    background: '#101018',
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });

  const mount = document.getElementById('app');
  if (!mount) throw new Error('#app mount point missing');
  mount.appendChild(app.canvas);

  // Sketch of the playfield silhouette: scratch lane (wide, red) + 7 key lanes.
  const laneX = 100;
  const laneTop = 40;
  const laneHeight = 560;
  const scratchWidth = 90;
  const keyWidth = 60;
  const g = new Graphics();
  g.rect(laneX, laneTop, scratchWidth, laneHeight).fill({ color: 0x2a1015 });
  for (let i = 0; i < 7; i++) {
    const x = laneX + scratchWidth + i * keyWidth;
    g.rect(x, laneTop, keyWidth, laneHeight).fill({ color: i % 2 === 0 ? 0x14141c : 0x10202c });
  }
  const totalWidth = scratchWidth + 7 * keyWidth;
  g.rect(laneX, laneTop + laneHeight, totalWidth, 4).fill({ color: 0xff3344 });
  app.stage.addChild(g);

  const label = new Text({
    text: 'IIDX Web — scaffold OK (Milestone 0)',
    style: { fill: 0xe8e8f0, fontSize: 24 },
  });
  label.position.set(laneX, laneTop + laneHeight + 24);
  app.stage.addChild(label);
}

boot().catch((err: unknown) => {
  console.error('boot failed', err);
  const mount = document.getElementById('app');
  if (mount) {
    mount.textContent = `WebGL 초기화에 실패했습니다: ${err instanceof Error ? err.message : String(err)}`;
  }
});
