import {
  SparkRenderer,
  SplatEdit,
  SplatMesh,
} from '@sparkjsdev/spark';
import {
  Camera,
  Matrix4,
  Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';
import {
  isGaussianSplat,
  type SupportedSparkRendererOptions,
} from './GaussianSplatPlugin';

const _cameraInverseWorldMatrix = new Matrix4();
const _parentInverseWorldMatrix = new Matrix4();
const _rebasedLocalMatrix = new Matrix4();

const _displayFrameInverseWorldMatrix = new Matrix4();
const _relativeRenderCameraMatrix = new Matrix4();

type RebasedCameraRelativeRoot = {
  target: Object3D | null;
  originalMatrix: Matrix4;
  originalMatrixAutoUpdate: boolean;
};

type SparkRendererUpdateInternals = {
  updateInternal(options: {
    scene: Scene;
    camera: Camera;
    autoUpdate: boolean;
  }): Promise<void>;
};

function ensureCameraClone(cached: Camera | null, source: Camera): Camera {
  if (!cached || cached.constructor !== source.constructor) {
    return source.clone();
  }
  cached.copy(source, false);
  return cached;
}

function isGaussianSplatNode(node: Object3D): node is SplatMesh {
  return node instanceof SplatMesh || isGaussianSplat(node);
}

function isCameraRelativeEdit(
  node: Object3D,
  hasGaussianSplatAncestor: boolean,
): node is SplatEdit {
  return node instanceof SplatEdit && !hasGaussianSplatAncestor;
}

export class CameraRelativeSparkRenderer extends SparkRenderer {
  #updateCamera: Camera | null = null;
  #renderCamera: Camera | null = null;
  #cameraWorldSnapshot = new Matrix4();

  #lastXrHandledFrame = -1;

  #rebasedRootsPool: RebasedCameraRelativeRoot[] = [];
  #rebasedRootsCount = 0;
  #prevRebasedRootsCount = 0;
  #hadRebasedLastFrame = false;

  constructor(
    renderer: WebGLRenderer,
    options: SupportedSparkRendererOptions = {},
  ) {
    super({
      ...options,
      renderer,
      autoUpdate: false,
      preUpdate: false,
    });

    this.matrixAutoUpdate = false;
    this.raycast = () => {};
  }

  override onBeforeRender(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
  ) {
    const xrPresenting = renderer.xr.isPresenting;
    const updateSourceCamera = xrPresenting ? renderer.xr.getCamera() : camera;
    if (!xrPresenting) {
      camera.updateMatrixWorld(true);
    }

    const rebasedCount = this.#rebaseCameraRelativeRoots(
      scene,
      updateSourceCamera,
    );
    const hasRebased = rebasedCount > 0;
    const renderFrame = renderer.info.render.frame;
    const shouldHandleFrameState =
      !xrPresenting || this.#lastXrHandledFrame !== renderFrame;

    try {
      if (shouldHandleFrameState) {
        this.#lastXrHandledFrame = renderFrame;
      }

      if (
        (hasRebased || this.#hadRebasedLastFrame) &&
        shouldHandleFrameState
      ) {
        const updateCamera = this.#getUpdateCamera(updateSourceCamera);
        const prevDisplay = this.display;
        const prevCurrent = this.current;

        const cameraWorldSnapshot = this.#cameraWorldSnapshot.copy(
          updateSourceCamera.matrixWorld,
        );

        void this.#updateSparkIfNeeded({
          scene,
          camera: updateCamera,
        }).catch((error: unknown) => {
          console.error(
            'CameraRelativeSparkRenderer: Spark update failed',
            error,
          );
        });

        // updateInternal assigns this.current/this.display before its async
        // sort/upload work, so the new accumulator can be fixed up immediately.
        // Spark receives an identity-rebased camera, so it writes identity
        // into accumulator.viewToWorld. Overwrite it back to the real world
        // frame that these camera-local splats actually correspond to.
        if (this.current !== prevCurrent) {
          this.current.viewToWorld.copy(cameraWorldSnapshot);
        }

        if (this.display !== prevDisplay) {
          this.display.viewToWorld.copy(cameraWorldSnapshot);
        }
      }

      if (shouldHandleFrameState) {
        this.#hadRebasedLastFrame = hasRebased;
      }

      // Build a relative camera from the display's world frame
      // instead of always passing the identity-rebased camera.
      const renderCamera = hasRebased ? this.#getRenderCamera(camera) : camera;
      super.onBeforeRender(renderer, scene, renderCamera);
    } finally {
      this.#restoreCameraRelativeRoots();
    }
  }

  #updateSparkIfNeeded({
    scene,
    camera,
  }: {
    scene: Scene;
    camera: Camera;
  }) {
    // Reuse Spark's auto-update skip logic while keeping our identity camera.
    return (this as unknown as SparkRendererUpdateInternals).updateInternal({
      scene,
      camera,
      autoUpdate: true,
    });
  }

  /**
   * Identity camera for the update pass - makes Spark treat
   * the camera's own frame as the reference frame.
   */
  #getUpdateCamera(camera: Camera) {
    this.#updateCamera = ensureCameraClone(this.#updateCamera, camera);
    const updateCamera = this.#updateCamera;
    updateCamera.position.set(0, 0, 0);
    updateCamera.quaternion.identity();
    updateCamera.scale.set(1, 1, 1);
    updateCamera.matrixAutoUpdate = false;
    updateCamera.matrix.identity();
    updateCamera.matrixWorld.identity();
    updateCamera.matrixWorldInverse.identity();
    updateCamera.matrixWorldNeedsUpdate = false;
    return updateCamera;
  }

  /**
   * Render-pass camera:
   *   relative = inverse(displayFrameWorld) * currentCameraWorld
   */
  #getRenderCamera(camera: Camera) {
    this.#renderCamera = ensureCameraClone(this.#renderCamera, camera);
    const renderCamera = this.#renderCamera;

    _displayFrameInverseWorldMatrix.copy(this.display.viewToWorld).invert();

    _relativeRenderCameraMatrix
      .copy(_displayFrameInverseWorldMatrix)
      .multiply(camera.matrixWorld);

    renderCamera.matrixAutoUpdate = false;
    renderCamera.matrix.copy(_relativeRenderCameraMatrix);
    renderCamera.matrix.decompose(
      renderCamera.position,
      renderCamera.quaternion,
      renderCamera.scale,
    );
    renderCamera.matrixWorld.copy(_relativeRenderCameraMatrix);
    // inverse(A * B) = inverse(B) * inverse(A)
    // = camera.matrixWorldInverse * display.viewToWorld
    renderCamera.matrixWorldInverse
      .copy(camera.matrixWorldInverse)
      .multiply(this.display.viewToWorld);
    renderCamera.matrixWorldNeedsUpdate = false;
    return renderCamera;
  }

  #rebaseCameraRelativeRoots(scene: Scene, camera: Camera): number {
    this.#rebasedRootsCount = 0;
    _cameraInverseWorldMatrix.copy(camera.matrixWorld).invert();

    this.#visitVisibleCameraRelativeRoots(scene, false, false);

    return this.#rebasedRootsCount;
  }

  #visitVisibleCameraRelativeRoots(
    node: Object3D,
    hasGaussianSplatAncestor: boolean,
    hasCameraRelativeAncestor: boolean,
  ) {
    if (!node.visible) {
      return;
    }

    const isSplatNode = isGaussianSplatNode(node);
    const isCameraRelativeNode =
      isSplatNode || isCameraRelativeEdit(node, hasGaussianSplatAncestor);

    // Carry ancestor state through traversal to avoid repeatedly walking
    // parent chains for every splat/edit node in the hot render path.
    if (isCameraRelativeNode && !hasCameraRelativeAncestor) {
      this.#rebaseCameraRelativeRoot(node);
    }

    const nextHasGaussianSplatAncestor =
      hasGaussianSplatAncestor || isSplatNode;
    const nextHasCameraRelativeAncestor =
      hasCameraRelativeAncestor || isCameraRelativeNode;
    const { children } = node;

    for (let i = 0, l = children.length; i < l; i++) {
      this.#visitVisibleCameraRelativeRoots(
        children[i],
        nextHasGaussianSplatAncestor,
        nextHasCameraRelativeAncestor,
      );
    }
  }

  #rebaseCameraRelativeRoot(node: Object3D) {
    const idx = this.#rebasedRootsCount++;
    const pool = this.#rebasedRootsPool;

    if (idx >= pool.length) {
      pool.push({
        target: node,
        originalMatrix: node.matrix.clone(),
        originalMatrixAutoUpdate: node.matrixAutoUpdate,
      });
    } else {
      const entry = pool[idx];
      entry.target = node;
      entry.originalMatrix.copy(node.matrix);
      entry.originalMatrixAutoUpdate = node.matrixAutoUpdate;
    }

    const parent = node.parent;
    if (!parent) {
      // Defensive path for direct calls or detached camera-relative roots.
      _rebasedLocalMatrix
        .copy(_cameraInverseWorldMatrix)
        .multiply(node.matrixWorld);
    } else {
      _rebasedLocalMatrix
        .copy(_parentInverseWorldMatrix.copy(parent.matrixWorld).invert())
        .multiply(_cameraInverseWorldMatrix)
        .multiply(node.matrixWorld);
    }

    node.matrixAutoUpdate = false;
    node.matrix.copy(_rebasedLocalMatrix);
    node.matrixWorldNeedsUpdate = true;
    node.updateMatrixWorld(true);
  }

  #restoreCameraRelativeRoots() {
    const pool = this.#rebasedRootsPool;
    const currentCount = this.#rebasedRootsCount;
    for (let i = currentCount - 1; i >= 0; i--) {
      const { target, originalMatrix, originalMatrixAutoUpdate } = pool[i];
      if (!target) continue;
      target.matrix.copy(originalMatrix);
      target.matrixAutoUpdate = originalMatrixAutoUpdate;
      target.matrixWorldNeedsUpdate = true;
      target.updateMatrixWorld(true);
    }
    for (let i = currentCount; i < this.#prevRebasedRootsCount; i++) {
      pool[i].target = null;
    }
    this.#prevRebasedRootsCount = currentCount;
  }
}
