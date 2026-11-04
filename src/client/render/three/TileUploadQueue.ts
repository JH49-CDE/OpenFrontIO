/**
 * TileUploadQueue — which parts of a per-tile texture still have to reach
 * the GPU, and how to send them in few `texSubImage2D` calls spread over
 * frames. Pure bookkeeping: no three, no GL (TerrainLayer does the uploads).
 *
 * Why: three uploads `DataTexture.updateRanges` with one `texSubImage2D`
 * per range, and a range is one row. A hydrogen bomb (outer radius 100)
 * changes ~31k tiles over ~200 rows in one tick, so per-row spans meant
 * hundreds of calls in one frame. In Chrome every call is a command for the
 * GPU process (with ANGLE/D3D11, a staging copy each), so that cost never
 * shows in the page's JS time. The default renderer avoids it altogether
 * (`TerritoryPass`: drip buckets plus a GPU scatter pass).
 *
 * How:
 * - The map is cut into `cell`×`cell` tile cells (`TILE_UPLOAD_CELL`). A
 *   changed tile only marks its cell dirty: O(changed tiles), and the
 *   pending work is bounded by the cell count however long frames stall
 *   (a background tab keeps receiving ticks without drawing).
 * - `take()` covers the dirty cells with rectangles: runs of dirty cells
 *   along a cell row (bridging clean gaps), merged down the following rows
 *   while a merge adds at most `TILE_UPLOAD_MERGE_WASTE_TEXELS` of clean
 *   cells (about one call's worth). A dense band, such as a nuke's disc,
 *   becomes one rectangle.
 * - With a budget it hands out at most `maxCalls` rectangles and
 *   `maxTexels` texels, but always at least one. Rectangles go in scan
 *   order from a cursor (cell row, then column) that the next take resumes
 *   from, so the cursor moves forward on every take and goes round the map.
 * - A cell is marked clean only when a rectangle covering it is handed out,
 *   so nothing is ever dropped. Rectangles may also cover clean cells: the
 *   texture source is the live buffer, so re-sending them is harmless, and a
 *   deferred rectangle always sends the latest values.
 */

/** Cell size in tiles (one dirty flag per cell). */
export const TILE_UPLOAD_CELL = 16;
/**
 * Clean texels a merge (or a bridged gap) may add: 4096 texels (8 KB of
 * R16, 16 cells of 16×16), less than one more upload call costs. Replaying
 * recorded ticks of a 30-bot World game (dev harness), it gave ~27 calls
 * and ~78k texels per tick, where per-row spans gave ~144 calls and ~9.5k
 * texels; 8192 gave ~21 calls but ~172k texels.
 */
export const TILE_UPLOAD_MERGE_WASTE_TEXELS = 4096;

export interface TileUploadBudget {
  /** Most rectangles (upload calls) per `take`. */
  readonly maxCalls: number;
  /** Most texels per `take` (the first rectangle is always handed out). */
  readonly maxTexels: number;
}

/** A rectangle of tiles to upload (clipped to the map). */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class TileUploadQueue {
  /** Cell columns / rows. */
  readonly cols: number;
  readonly rows: number;
  private readonly dirty: Uint8Array;
  /** Dirty cells per cell row (skips clean rows without scanning them). */
  private readonly rowDirty: Int32Array;
  private pendingCellCount = 0;
  private pendingTexelCount = 0;
  /** Scan position (cell row, cell column) the next `take` starts at. */
  private cursorRow = 0;
  private cursorCol = 0;

  // Scratch, in cell coordinates, reused by every `take`.
  private readonly runX0: Int32Array;
  private readonly runX1: Int32Array;
  private readonly runUsed: Uint8Array;
  // Open rectangles (still growing down), current and next row.
  private openX0: Int32Array;
  private openX1: Int32Array;
  private openY0: Int32Array;
  private nextX0: Int32Array;
  private nextX1: Int32Array;
  private nextY0: Int32Array;
  // Closed rectangles of this take, and their order.
  private readonly rectX0: Int32Array;
  private readonly rectX1: Int32Array;
  private readonly rectY0: Int32Array;
  private readonly rectY1: Int32Array;
  private readonly order: Float64Array;
  private readonly rectPool: TileRect[] = [];
  /** `TILE_UPLOAD_MERGE_WASTE_TEXELS` in cells. */
  private readonly mergeWaste: number;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell: number = TILE_UPLOAD_CELL,
    mergeWasteTexels: number = TILE_UPLOAD_MERGE_WASTE_TEXELS,
  ) {
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.mergeWaste = Math.max(1, Math.floor(mergeWasteTexels / (cell * cell)));
    const cells = this.cols * this.rows;
    this.dirty = new Uint8Array(cells);
    this.rowDirty = new Int32Array(this.rows);
    // Runs of one row are separated by clean cells: at most cols/2 + 1.
    const maxRuns = Math.ceil(this.cols / 2) + 1;
    this.runX0 = new Int32Array(maxRuns);
    this.runX1 = new Int32Array(maxRuns);
    this.runUsed = new Uint8Array(maxRuns);
    this.openX0 = new Int32Array(maxRuns);
    this.openX1 = new Int32Array(maxRuns);
    this.openY0 = new Int32Array(maxRuns);
    this.nextX0 = new Int32Array(maxRuns);
    this.nextX1 = new Int32Array(maxRuns);
    this.nextY0 = new Int32Array(maxRuns);
    // Every closed rectangle owns at least one dirty cell.
    this.rectX0 = new Int32Array(cells);
    this.rectX1 = new Int32Array(cells);
    this.rectY0 = new Int32Array(cells);
    this.rectY1 = new Int32Array(cells);
    this.order = new Float64Array(cells);
  }

  /** Dirty cells waiting for an upload. */
  get pendingCells(): number {
    return this.pendingCellCount;
  }

  /** Texels of the dirty cells (clipped to the map). */
  get pendingTexels(): number {
    return this.pendingTexelCount;
  }

  get empty(): boolean {
    return this.pendingCellCount === 0;
  }

  /** Mark the cells of these tile refs (y·width + x) dirty. */
  markTiles(refs: readonly number[]): void {
    const W = this.width;
    const H = this.height;
    const c = this.cell;
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      if (!(ref >= 0)) continue;
      const y = Math.floor(ref / W);
      if (y >= H) continue;
      const x = ref - y * W;
      this.markCell(Math.floor(x / c), Math.floor(y / c));
    }
  }

  /** Mark every cell overlapping the tile rectangle dirty. */
  markRect(x: number, y: number, w: number, h: number): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const c = this.cell;
    for (let cy = Math.floor(y0 / c); cy <= Math.floor((y1 - 1) / c); cy++) {
      for (let cx = Math.floor(x0 / c); cx <= Math.floor((x1 - 1) / c); cx++) {
        this.markCell(cx, cy);
      }
    }
  }

  /** Is the cell holding tile (x, y) waiting for an upload? */
  isTileDirty(x: number, y: number): boolean {
    const c = this.cell;
    return this.dirty[Math.floor(y / c) * this.cols + Math.floor(x / c)] !== 0;
  }

  /** Everything is on the GPU (a full upload covered it). */
  clear(): void {
    if (this.pendingCellCount === 0) return;
    this.dirty.fill(0);
    this.rowDirty.fill(0);
    this.pendingCellCount = 0;
    this.pendingTexelCount = 0;
  }

  /**
   * Cover the dirty cells with rectangles, hand out the first ones in scan
   * order from the cursor (all of them when `budget` is null), mark their
   * cells clean and move the cursor past them. Returns tile rectangles
   * clipped to the map; the array and its objects are reused by the next
   * call.
   */
  take(budget: TileUploadBudget | null): readonly TileRect[] {
    const out = this.rectPool;
    if (this.pendingCellCount === 0) {
      out.length = 0;
      return out;
    }
    const maxCalls = budget === null ? Infinity : Math.max(1, budget.maxCalls);
    const maxTexels = budget === null ? Infinity : budget.maxTexels;
    const count = this.planRects(maxTexels);

    // Scan order from the cursor: row steps after the cursor row, then
    // columns; runs of the cursor row left of the cursor come last.
    const rows = this.rows;
    const cols = this.cols;
    const order = this.order;
    const cycle = rows * cols;
    for (let k = 0; k < count; k++) {
      const step = (this.rectY0[k] - this.cursorRow + rows) % rows;
      let pos = step * cols + this.rectX0[k];
      if (step === 0 && this.rectX0[k] < this.cursorCol) pos += cycle;
      // pos < 2·cycle ≤ 2^31 and k < cycle: exact in a double.
      order[k] = pos * cycle + k;
    }
    const sorted = order.subarray(0, count).sort();

    let n = 0;
    let texels = 0;
    for (let i = 0; i < count; i++) {
      const k = sorted[i] % cycle;
      const area = this.rectTexels(k);
      if (n > 0 && (n >= maxCalls || texels + area > maxTexels)) {
        // Resume at the first rectangle left out.
        this.cursorRow = this.rectY0[k];
        this.cursorCol = this.rectX0[k];
        break;
      }
      for (let cy = this.rectY0[k]; cy <= this.rectY1[k]; cy++) {
        for (let cx = this.rectX0[k]; cx <= this.rectX1[k]; cx++) {
          this.clearCell(cx, cy);
        }
      }
      let r = out[n];
      if (r === undefined) {
        r = { x: 0, y: 0, w: 0, h: 0 };
        out[n] = r;
      }
      this.rectToTiles(k, r);
      n++;
      texels += area;
    }
    out.length = n;
    return out;
  }

  // ---- Internals ----

  /**
   * Cover every dirty cell with closed rectangles (rect* scratch arrays):
   * row-major runs merged downwards, no rectangle over `maxTexels` unless
   * it is a single run. Rectangles never wrap from the last row to the
   * first. Returns the rectangle count.
   */
  private planRects(maxTexels: number): number {
    const rows = this.rows;
    const cellTexels = this.cell * this.cell;
    let count = 0;
    let open = 0;
    for (let y = 0; y < rows; y++) {
      if (this.rowDirty[y] === 0) {
        for (let k = 0; k < open; k++) count = this.closeRect(count, k, y - 1);
        open = 0;
        continue;
      }
      const runs = this.collectRuns(y);
      this.runUsed.fill(0, 0, runs);
      let next = 0;
      // Extend each open rectangle with the first run it absorbs cheaply.
      for (let k = 0; k < open; k++) {
        const ox0 = this.openX0[k];
        const ox1 = this.openX1[k];
        const h = y - this.openY0[k];
        let merged = -1;
        for (let j = 0; j < runs; j++) {
          if (this.runUsed[j] !== 0) continue;
          const rx0 = this.runX0[j];
          const rx1 = this.runX1[j];
          const ux0 = Math.min(ox0, rx0);
          const ux1 = Math.max(ox1, rx1);
          const union = (ux1 - ux0 + 1) * (h + 1);
          const waste = union - (ox1 - ox0 + 1) * h - (rx1 - rx0 + 1);
          if (waste > this.mergeWaste) continue;
          if (union * cellTexels > maxTexels) continue;
          merged = j;
          break;
        }
        if (merged < 0) {
          count = this.closeRect(count, k, y - 1);
          continue;
        }
        this.runUsed[merged] = 1;
        this.nextX0[next] = Math.min(ox0, this.runX0[merged]);
        this.nextX1[next] = Math.max(ox1, this.runX1[merged]);
        this.nextY0[next] = this.openY0[k];
        next++;
      }
      for (let j = 0; j < runs; j++) {
        if (this.runUsed[j] !== 0) continue;
        this.nextX0[next] = this.runX0[j];
        this.nextX1[next] = this.runX1[j];
        this.nextY0[next] = y;
        next++;
      }
      this.swapOpen();
      open = next;
    }
    for (let k = 0; k < open; k++) count = this.closeRect(count, k, rows - 1);
    return count;
  }

  /** Closes open rectangle `k` at cell row `y1` as rectangle `count`. */
  private closeRect(count: number, k: number, y1: number): number {
    this.rectX0[count] = this.openX0[k];
    this.rectX1[count] = this.openX1[k];
    this.rectY0[count] = this.openY0[k];
    this.rectY1[count] = y1;
    return count + 1;
  }

  /**
   * Runs of dirty cells in cell row `y`, bridging clean gaps worth at most
   * `TILE_UPLOAD_MERGE_WASTE_TEXELS`. Returns the run count.
   */
  private collectRuns(y: number): number {
    const cols = this.cols;
    const base = y * cols;
    const d = this.dirty;
    let runs = 0;
    let x = 0;
    while (x < cols) {
      if (d[base + x] === 0) {
        x++;
        continue;
      }
      const start = x;
      let end = x;
      x++;
      while (x < cols) {
        if (d[base + x] !== 0) {
          end = x++;
          continue;
        }
        let gap = 0;
        while (x + gap < cols && d[base + x + gap] === 0) gap++;
        if (x + gap >= cols || gap > this.mergeWaste) break;
        x += gap;
      }
      this.runX0[runs] = start;
      this.runX1[runs] = end;
      runs++;
      x = end + 1;
    }
    return runs;
  }

  private rectToTiles(k: number, r: TileRect): void {
    const c = this.cell;
    r.x = this.rectX0[k] * c;
    r.y = this.rectY0[k] * c;
    r.w = Math.min(this.width, (this.rectX1[k] + 1) * c) - r.x;
    r.h = Math.min(this.height, (this.rectY1[k] + 1) * c) - r.y;
  }

  private rectTexels(k: number): number {
    const c = this.cell;
    const x = this.rectX0[k] * c;
    const y = this.rectY0[k] * c;
    return (
      (Math.min(this.width, (this.rectX1[k] + 1) * c) - x) *
      (Math.min(this.height, (this.rectY1[k] + 1) * c) - y)
    );
  }

  private markCell(cx: number, cy: number): void {
    const i = cy * this.cols + cx;
    if (this.dirty[i] !== 0) return;
    this.dirty[i] = 1;
    this.rowDirty[cy]++;
    this.pendingCellCount++;
    this.pendingTexelCount += this.cellArea(cx, cy);
  }

  private clearCell(cx: number, cy: number): void {
    const i = cy * this.cols + cx;
    if (this.dirty[i] === 0) return;
    this.dirty[i] = 0;
    this.rowDirty[cy]--;
    this.pendingCellCount--;
    this.pendingTexelCount -= this.cellArea(cx, cy);
  }

  private cellArea(cx: number, cy: number): number {
    const c = this.cell;
    return (
      (Math.min(this.width, (cx + 1) * c) - cx * c) *
      (Math.min(this.height, (cy + 1) * c) - cy * c)
    );
  }

  private swapOpen(): void {
    let t = this.openX0;
    this.openX0 = this.nextX0;
    this.nextX0 = t;
    t = this.openX1;
    this.openX1 = this.nextX1;
    this.nextX1 = t;
    t = this.openY0;
    this.openY0 = this.nextY0;
    this.nextY0 = t;
  }
}
