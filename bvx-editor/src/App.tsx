import { useCallback, useEffect, useRef, useState } from "react";
import { VoxelEditor, type EditorStats, type EditorTool, type RenderMode } from "./editor/voxel-editor";
import { PALETTE } from "./editor/palette";
import {
    BlobIcon,
    BrushIcon,
    CubeIcon,
    WireframeIcon,
    EraserIcon,
    LoadIcon,
    NewIcon,
    PauseIcon,
    PickerIcon,
    PlayIcon,
    RedoIcon,
    SandIcon,
    SaveIcon,
    SparkleIcon,
    TrashIcon,
    UndoIcon,
    WaterIcon
} from "./ui/Icons";

/**
 * The BitVoxel Editor application shell - a BabylonJS viewport with a left
 * tool rail and a right inspector panel, all wired into the VoxelEditor.
 */
export const App = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const editorRef = useRef<VoxelEditor | null>(null);

    // the in-flight (or settled) editor startup, and the pending teardown a
    // remount cancels - see the lifecycle effect below
    const startupRef = useRef<Promise<VoxelEditor> | null>(null);
    const teardownRef = useRef<number | null>(null);

    const [tool, setTool] = useState<EditorTool>("paint");
    const [brushSize, setBrushSize] = useState(1);
    const [colorIndex, setColorIndex] = useState(6);
    const [renderMode, setRenderMode] = useState<RenderMode>("blocky");
    const [smoothing, setSmoothing] = useState(1);
    const [occlusion, setOcclusion] = useState(true);
    const [playing, setPlaying] = useState(true);
    const [stats, setStats] = useState<EditorStats>({ chunks: 0, bitVoxels: 0, triangles: 0, workers: 0, meshQueued: 0, meshInFlight: 0, meshPending: 0, sandGrains: 0, waterGrains: 0, activeGrains: 0, fps: 0, cpuFrameTime: 0, drawnMeshes: 0 });
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    const [startupError, setStartupError] = useState<string | null>(null);

    // ----- editor lifecycle -----

    useEffect(() => {
        const canvas = canvasRef.current;

        if (!canvas) {
            return;
        }

        // The WebGPU device comes up asynchronously, which makes this effect's
        // lifetime awkward: React mounts effects twice in development, and
        // starting a second engine before the first has finished leaves two
        // devices configured on one canvas - they take the canvas from each
        // other and the surviving one never presents again, so the editor comes
        // up as a frozen first frame.
        //
        // So startup is memoised for the component's lifetime and teardown is
        // deferred by a task. A development remount runs synchronously right
        // after the cleanup and cancels the teardown; a real unmount does not.
        if (teardownRef.current !== null) {
            clearTimeout(teardownRef.current);
            teardownRef.current = null;
        }

        startupRef.current ??= VoxelEditor.create(canvas);

        let cancelled = false;

        void startupRef.current
            .then((editor) => {
                if (cancelled) {
                    return;
                }

                editor.onStats = setStats;
                editor.onColorPicked = (picked) => {
                    setColorIndex(picked);
                    setTool("paint");
                    editor.setTool("paint");
                };
                editor.onHistoryChanged = (undo, redo) => {
                    setCanUndo(undo);
                    setCanRedo(redo);
                };

                editorRef.current = editor;
                setOcclusion(editor.occlusionEnabled);

                // a handle for poking at the scene from the browser console
                // while tuning the look
                Reflect.set(window, "bvxEditor", editor);

                // start with something to look at, but only the first time -
                // a remount reattaches to the editor that is already running
                if (editor.isEmpty) {
                    editor.demoScene();
                }
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setStartupError(error instanceof Error ? error.message : String(error));
                }
            });

        return () => {
            cancelled = true;
            editorRef.current = null;

            const startup = startupRef.current;

            teardownRef.current = window.setTimeout(() => {
                teardownRef.current = null;
                startupRef.current = null;

                void startup?.then((editor) => editor.dispose()).catch(() => undefined);
            }, 0);
        };
    }, []);

    // ----- actions -----

    const selectTool = useCallback((next: EditorTool) => {
        setTool(next);
        editorRef.current?.setTool(next);
    }, []);

    const selectBrushSize = useCallback((size: number) => {
        setBrushSize(size);
        editorRef.current?.setBrushSize(size);
    }, []);

    const selectColor = useCallback((index: number) => {
        setColorIndex(index);
        editorRef.current?.setColorIndex(index);
    }, []);

    const selectRenderMode = useCallback((mode: RenderMode) => {
        setRenderMode(mode);
        editorRef.current?.setRenderMode(mode);
    }, []);

    const selectSmoothing = useCallback((value: number) => {
        setSmoothing(value);
        editorRef.current?.setSmoothing(value);
    }, []);

    const toggleOcclusion = useCallback(() => {
        setOcclusion((current) => {
            editorRef.current?.setOcclusionEnabled(!current);

            return !current;
        });
    }, []);

    const togglePlaying = useCallback(() => {
        setPlaying((current) => {
            editorRef.current?.setPlaying(!current);

            return !current;
        });
    }, []);

    const saveScene = useCallback(() => {
        const editor = editorRef.current;

        if (!editor) {
            return;
        }

        const data = editor.save();
        const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);

        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "scene.bvx";
        anchor.click();

        URL.revokeObjectURL(url);
    }, []);

    const loadScene = useCallback(async (file: File) => {
        const editor = editorRef.current;

        if (!editor) {
            return;
        }

        const buffer = await file.arrayBuffer();

        editor.load(new Uint8Array(buffer));
    }, []);

    // ----- keyboard shortcuts -----

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const editor = editorRef.current;

            if (!editor || event.target instanceof HTMLInputElement) {
                return;
            }

            const meta = event.metaKey || event.ctrlKey;

            if (meta && event.key.toLowerCase() === "z") {
                event.preventDefault();

                if (event.shiftKey) {
                    editor.redo();
                }
                else {
                    editor.undo();
                }

                return;
            }

            if (meta && event.key.toLowerCase() === "s") {
                event.preventDefault();
                saveScene();

                return;
            }

            switch (event.key.toLowerCase()) {
                case "b": selectTool("paint"); break;
                case "e": selectTool("erase"); break;
                case "i": selectTool("pick"); break;
                case "s": selectTool("sand"); break;
                case "w": selectTool("water"); break;
                case "f": editor.frameContent(); break;
                case "[": selectBrushSize(editor.brushSize - 1); break;
                case "]": selectBrushSize(editor.brushSize + 1); break;
                case "1": case "2": case "3": case "4":
                    selectBrushSize(parseInt(event.key, 10));
                    break;
                case "tab": {
                    event.preventDefault();

                    const order: RenderMode[] = ["blocky", "smooth", "wireframe"];

                    selectRenderMode(order[(order.indexOf(renderMode) + 1) % order.length]);
                    break;
                }
                case " ":
                    event.preventDefault();
                    togglePlaying();
                    break;
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [renderMode, saveScene, selectBrushSize, selectRenderMode, selectTool, togglePlaying]);

    // ----- render -----

    return (
        <div className="app">
            <header className="topbar">
                <div className="brand">
                    <span className="brand-mark">
                        <span /><span /><span /><span />
                    </span>
                    <span className="brand-name">BitVoxel <em>Editor</em></span>
                </div>

                <div className="topbar-actions">
                    <button className="action" title="New scene" onClick={() => editorRef.current?.newScene()}>
                        <NewIcon /> <span>New</span>
                    </button>
                    <button className="action" title="Generate demo scene" onClick={() => editorRef.current?.demoScene()}>
                        <SparkleIcon /> <span>Demo</span>
                    </button>

                    <span className="divider" />

                    <button className="action icon-only" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => editorRef.current?.undo()}>
                        <UndoIcon />
                    </button>
                    <button className="action icon-only" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => editorRef.current?.redo()}>
                        <RedoIcon />
                    </button>

                    <span className="divider" />

                    <button className="action" title="Save scene (.bvx)" onClick={saveScene}>
                        <SaveIcon /> <span>Save</span>
                    </button>
                    <button className="action" title="Load scene (.bvx)" onClick={() => fileRef.current?.click()}>
                        <LoadIcon /> <span>Load</span>
                    </button>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".bvx"
                        style={{ display: "none" }}
                        onChange={(event) => {
                            const file = event.target.files?.[0];

                            if (file) {
                                void loadScene(file);
                            }

                            event.target.value = "";
                        }}
                    />
                </div>
            </header>

            <div className="workspace">
                <aside className="toolrail">
                    <div className="rail-group">
                        <button className={`rail-button ${tool === "paint" ? "active" : ""}`} title="Paint (B)" onClick={() => selectTool("paint")}>
                            <BrushIcon size={20} />
                        </button>
                        <button className={`rail-button ${tool === "erase" ? "active" : ""}`} title="Erase (E)" onClick={() => selectTool("erase")}>
                            <EraserIcon size={20} />
                        </button>
                        <button className={`rail-button ${tool === "pick" ? "active" : ""}`} title="Pick colour (I)" onClick={() => selectTool("pick")}>
                            <PickerIcon size={20} />
                        </button>
                    </div>

                    <div className="rail-label">Physics</div>

                    <div className="rail-group">
                        <button className={`rail-button sand ${tool === "sand" ? "active" : ""}`} title="Pour sand (S)" onClick={() => selectTool("sand")}>
                            <SandIcon size={20} />
                        </button>
                        <button className={`rail-button water ${tool === "water" ? "active" : ""}`} title="Pour water (W)" onClick={() => selectTool("water")}>
                            <WaterIcon size={20} />
                        </button>
                    </div>

                    <div className="rail-label">Brush</div>

                    <div className="rail-group">
                        {[1, 2, 3, 4].map((size) => (
                            <button
                                key={size}
                                className={`rail-button brush ${brushSize === size ? "active" : ""}`}
                                title={`Brush size ${size} (${size})`}
                                onClick={() => selectBrushSize(size)}
                            >
                                <span className="brush-dot" style={{ width: 4 + size * 3, height: 4 + size * 3 }} />
                            </button>
                        ))}
                    </div>
                </aside>

                <main className="viewport">
                    <canvas ref={canvasRef} />

                    {startupError && (
                        <div className="viewport-error">
                            <h2>WebGPU required</h2>
                            <p>
                                The BitVoxel Editor renders through WebGPU. This browser could not
                                provide a device.
                            </p>
                            <p className="viewport-error-detail">{startupError}</p>
                            <p>
                                Chrome 113+, Edge 113+, Safari 26+ and Firefox 141+ support WebGPU;
                                on Linux it may need to be enabled explicitly.
                            </p>
                        </div>
                    )}

                    <div className="viewport-hint">
                        Draw: left-drag &nbsp;·&nbsp; Orbit: right-drag / ⌥-drag / 2-finger scroll &nbsp;·&nbsp; Pan: middle-drag / ⌥⇧-drag &nbsp;·&nbsp; Zoom: wheel / pinch &nbsp;·&nbsp; Frame: F
                    </div>
                </main>

                <aside className="inspector">
                    <section className="panel">
                        <h3>Rendering</h3>

                        <div className="segmented">
                            <button className={renderMode === "blocky" ? "active" : ""} onClick={() => selectRenderMode("blocky")}>
                                <CubeIcon size={15} /> Blocky
                            </button>
                            <button className={renderMode === "smooth" ? "active" : ""} onClick={() => selectRenderMode("smooth")}>
                                <BlobIcon size={15} /> Smooth
                            </button>
                            <button className={renderMode === "wireframe" ? "active" : ""} onClick={() => selectRenderMode("wireframe")}>
                                <WireframeIcon size={15} /> Wire
                            </button>
                        </div>

                        <div className={`field ${renderMode !== "smooth" ? "disabled" : ""}`}>
                            <label>
                                Smoothing
                                <span className="field-value">{smoothing}</span>
                            </label>
                            <input
                                type="range"
                                min={0}
                                max={3}
                                step={1}
                                value={smoothing}
                                disabled={renderMode !== "smooth"}
                                onChange={(event) => selectSmoothing(parseInt(event.target.value, 10))}
                            />
                        </div>

                        <label className="toggle">
                            <input type="checkbox" checked={occlusion} onChange={toggleOcclusion} />
                            <span>Screen-space occlusion</span>
                        </label>

                        <p className="note">Contact shading the baked occlusion cannot see.</p>
                    </section>

                    <section className="panel">
                        <h3>Palette</h3>

                        <div className="palette">
                            {PALETTE.map((color, index) => (
                                <button
                                    key={color.name}
                                    className={`swatch ${colorIndex === index ? "active" : ""}`}
                                    style={{ background: color.hex }}
                                    title={color.name}
                                    onClick={() => selectColor(index)}
                                />
                            ))}
                        </div>

                        <p className="note">Colours apply per Voxel (4×4×4 BitVoxels).</p>
                    </section>

                    <section className="panel">
                        <h3>Physics</h3>

                        <div className="physics-controls">
                            <button className={`physics-toggle ${playing ? "playing" : ""}`} title="Play/pause simulation (Space)" onClick={togglePlaying}>
                                {playing ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
                                {playing ? "Running" : "Paused"}
                            </button>
                            <button className="physics-clear" title="Remove all sand and water" onClick={() => editorRef.current?.clearPhysics()}>
                                <TrashIcon size={15} />
                            </button>
                        </div>

                        <dl className="stats">
                            <div><dt>Sand</dt><dd>{stats.sandGrains.toLocaleString()}</dd></div>
                            <div><dt>Water</dt><dd>{stats.waterGrains.toLocaleString()}</dd></div>
                            <div><dt>Moving</dt><dd>{stats.activeGrains.toLocaleString()}</dd></div>
                        </dl>

                        <p className="note">Sand piles and sinks through water. Water flows, pools and levels out.</p>
                    </section>

                    <section className="panel">
                        <h3>Statistics</h3>

                        <dl className="stats">
                            <div><dt>Frame rate</dt><dd>{Math.round(stats.fps)} fps</dd></div>
                            <div><dt>CPU frame</dt><dd>{stats.cpuFrameTime.toFixed(1)} ms</dd></div>
                            <div><dt>Chunks</dt><dd>{stats.chunks.toLocaleString()}</dd></div>
                            <div><dt>BitVoxels</dt><dd>{stats.bitVoxels.toLocaleString()}</dd></div>
                            <div><dt>Triangles</dt><dd>{stats.triangles.toLocaleString()}</dd></div>
                            <div><dt>Drawn meshes</dt><dd>{stats.drawnMeshes.toLocaleString()}</dd></div>
                            <div><dt>Mesh workers</dt><dd>{stats.workers}</dd></div>
                            <div><dt>Mesh backlog</dt><dd>{stats.meshPending.toLocaleString()} · {stats.meshQueued.toLocaleString()} · {stats.meshInFlight.toLocaleString()}</dd></div>
                        </dl>
                    </section>

                    <section className="panel">
                        <h3>Shortcuts</h3>

                        <dl className="shortcuts">
                            <div><dt>B / E / I</dt><dd>Paint / Erase / Pick</dd></div>
                            <div><dt>S / W</dt><dd>Sand / Water</dd></div>
                            <div><dt>Space</dt><dd>Play / pause physics</dd></div>
                            <div><dt>F</dt><dd>Frame the scene</dd></div>
                            <div><dt>1 – 4, [ ]</dt><dd>Brush size</dd></div>
                            <div><dt>Tab</dt><dd>Cycle render mode</dd></div>
                            <div><dt>⌥ drag</dt><dd>Orbit (trackpad)</dd></div>
                            <div><dt>⌥⇧ drag</dt><dd>Pan (trackpad)</dd></div>
                            <div><dt>Ctrl+Z</dt><dd>Undo</dd></div>
                            <div><dt>Ctrl+Shift+Z</dt><dd>Redo</dd></div>
                            <div><dt>Ctrl+S</dt><dd>Save scene</dd></div>
                        </dl>
                    </section>
                </aside>
            </div>
        </div>
    );
};
