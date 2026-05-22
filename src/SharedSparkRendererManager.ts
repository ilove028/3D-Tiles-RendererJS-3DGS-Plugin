import { WebGLRenderer, type Scene } from 'three';
import type { TilesRenderer } from '3d-tiles-renderer';
import {
  SPARK_RENDERER_OPTION_KEYS,
  type GaussianSplatPluginHost,
  type SupportedSparkRendererOptions,
} from './GaussianSplatPlugin';
import { CameraRelativeSparkRenderer } from './CameraRelativeSparkRenderer';
import type { SparkRenderer } from '@sparkjsdev/spark';

const _sharedSparkManagersByScene = new WeakMap<
  Scene,
  SharedSparkRendererManager
>();
const _sharedSparkManagersByRenderer = new WeakMap<
  WebGLRenderer,
  SharedSparkRendererManager
>();

type NormalizedSparkRendererOptions = SupportedSparkRendererOptions;

const CUSTOM_DEFAULT_OPTIONS: NormalizedSparkRendererOptions = {
  focalAdjustment: 2,
};

const MATERIAL_SPARK_RENDERER_OPTION_KEYS = new Set<string>([
  'depthTest',
  'depthWrite',
]);

function normalizeSparkRendererOptions(
  options: SupportedSparkRendererOptions = {},
  includeCustomDefaults = true,
) {
  const source = options as Record<string, unknown>;
  const defaults = CUSTOM_DEFAULT_OPTIONS as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of SPARK_RENDERER_OPTION_KEYS) {
    const value =
      source[key] !== undefined
        ? source[key]
        : includeCustomDefaults
          ? defaults[key]
          : undefined;
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized as NormalizedSparkRendererOptions;
}

class SharedSparkRendererManager {
  #sparkRenderer: CameraRelativeSparkRenderer;
  #scene: Scene;
  #sparkRendererOptions: NormalizedSparkRendererOptions;
  #notifyHandle: ReturnType<typeof setTimeout> | null = null;
  #disposeHandle: ReturnType<typeof setTimeout> | null = null;
  #tilesRenderers = new Set<TilesRenderer>();
  #disposed = false;
  readonly renderer: WebGLRenderer;

  constructor(host: GaussianSplatPluginHost) {
    this.#scene = host.scene;
    this.renderer = host.renderer;
    this.#sparkRendererOptions = normalizeSparkRendererOptions(
      host.sparkRendererOptions,
    );
    this.#sparkRenderer = new CameraRelativeSparkRenderer(
      host.renderer,
      this.#sparkRendererOptions,
    );
    this.#sparkRenderer.onDirty = () => {
      if (!this.#disposed) {
        this.#scheduleSortUpdatedNotification();
      }
    };
    host.scene.add(this.#sparkRenderer);
  }

  get sparkRenderer() {
    return this.#sparkRenderer;
  }

  retain(tiles: TilesRenderer) {
    this.#tilesRenderers.add(tiles);
  }

  applySparkRendererOptions(
    sparkRendererOptions: SupportedSparkRendererOptions = {},
    warnOnChange = true,
  ) {
    const next = normalizeSparkRendererOptions(
      sparkRendererOptions,
      false,
    ) as Record<string, unknown>;
    const prev = this.#sparkRendererOptions as Record<string, unknown>;
    const renderer = this.#sparkRenderer as unknown as Record<string, unknown>;
    const material = this.#sparkRenderer.material as unknown as Record<
      string,
      unknown
    >;

    let merged: Record<string, unknown> | null = null;

    for (const [key, nextValue] of Object.entries(next)) {
      const target = MATERIAL_SPARK_RENDERER_OPTION_KEYS.has(key)
        ? material
        : renderer;

      // With no tracked opinion yet, compare against the renderer's actual
      // current value so an explicit `next === current` is a no-op.
      const baseline = prev[key] !== undefined ? prev[key] : target[key];
      if (baseline === nextValue) continue;

      target[key] = nextValue;
      merged ??= { ...prev };
      merged[key] = nextValue;
    }

    if (!merged) return;

    this.#sparkRendererOptions = merged as NormalizedSparkRendererOptions;
    this.#sparkRenderer.setDirty();
    if (warnOnChange) {
      console.warn(
        `GaussianSplatPlugin: Updating shared sparkRendererOptions for Scene/WebGLRenderer. Existing: ${JSON.stringify(prev)}, received: ${JSON.stringify(next)}.`,
      );
    }
  }

  release(tiles: TilesRenderer) {
    this.#tilesRenderers.delete(tiles);
    if (this.#disposed || this.#tilesRenderers.size > 0) {
      return;
    }

    this.#dispose();
  }

  #dispose() {
    if (this.#disposed) return;
    this.#disposed = true;

    // Remove associations immediately
    _sharedSparkManagersByScene.delete(this.#scene);
    _sharedSparkManagersByRenderer.delete(this.renderer);
    this.#stopScheduledNotifications();
    this.#sparkRenderer.removeFromParent();
    this.#sparkRenderer.visible = false;
    this.#sparkRenderer.autoUpdate = false;
    this.#tilesRenderers.clear();
    this.#sparkRenderer.onDirty = undefined;
    this.#clearSparkRendererTimeouts();
    this.#sparkRenderer.clearSplats();
    this.#sparkRenderer.sortDirty = false;

    if (!this.#sparkRenderer.sorting) {
      this.#sparkRenderer.dispose();
      return;
    }

    this.#sparkRenderer.onDirty = () => {
      this.#sparkRenderer.sortDirty = false;
      if (this.#sparkRenderer.sorting) {
        this.#sparkRenderer.dirty = false;
        return;
      }

      this.#sparkRenderer.onDirty = undefined;
      setTimeout(() => {
        this.#sparkRenderer.dispose();
      }, 0);
    };
    this.#sparkRenderer.dirty = false;
  }

  #stopScheduledNotifications() {
    if (this.#notifyHandle !== null) {
      clearTimeout(this.#notifyHandle);
      this.#notifyHandle = null;
    }

    if (this.#disposeHandle !== null) {
      clearTimeout(this.#disposeHandle);
      this.#disposeHandle = null;
    }
  }

  #scheduleSortUpdatedNotification() {
    if (this.#notifyHandle !== null) {
      return;
    }

    this.#notifyHandle = setTimeout(() => {
      this.#notifyHandle = null;

      if (this.#disposed) {
        return;
      }

      for (const tilesRenderer of this.#tilesRenderers) {
        tilesRenderer.dispatchEvent({ type: 'needs-update' } as any);
      }
    }, 0);
  }

  #clearSparkRendererTimeouts() {
    if (this.#sparkRenderer.updateTimeoutId !== -1) {
      clearTimeout(this.#sparkRenderer.updateTimeoutId);
      this.#sparkRenderer.updateTimeoutId = -1;
    }

    if (this.#sparkRenderer.sortTimeoutId !== -1) {
      clearTimeout(this.#sparkRenderer.sortTimeoutId);
      this.#sparkRenderer.sortTimeoutId = -1;
    }
  }
}

export function getSharedSparkRendererManager(host: GaussianSplatPluginHost) {
  const managerByScene = _sharedSparkManagersByScene.get(host.scene);
  const managerByRenderer = _sharedSparkManagersByRenderer.get(host.renderer);

  if (managerByScene && managerByRenderer) {
    if (managerByScene !== managerByRenderer) {
      throw new Error(
        'GaussianSplatPlugin: Scene and WebGLRenderer are already bound to different SparkRenderer managers.',
      );
    }

    managerByScene.applySparkRendererOptions(host.sparkRendererOptions);
    return managerByScene;
  }

  if (managerByScene || managerByRenderer) {
    throw new Error(
      'GaussianSplatPlugin: Scene and WebGLRenderer must be bound in a strict 1:1:1 relationship.',
    );
  }

  const manager = new SharedSparkRendererManager(host);
  _sharedSparkManagersByScene.set(host.scene, manager);
  _sharedSparkManagersByRenderer.set(host.renderer, manager);

  return manager;
}

export function getSparkRendererForScene(scene: Scene): SparkRenderer | null {
  const manager = _sharedSparkManagersByScene.get(scene);
  return manager ? manager.sparkRenderer : null;
}

export function updateSharedSparkRendererOptions(
  scene: Scene,
  sparkRendererOptions: SupportedSparkRendererOptions,
) {
  const manager = _sharedSparkManagersByScene.get(scene);
  if (manager) {
    manager.applySparkRendererOptions(sparkRendererOptions, false);
  }
}

export type { SharedSparkRendererManager };
