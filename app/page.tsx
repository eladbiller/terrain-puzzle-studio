"use client";

// The builder has no server-side state. This lets the GitHub Pages build
// pre-render the shell while the terrain work continues in the browser.
export const dynamic = "force-static";

import {
  ChangeEvent,
  FormEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fromArrayBuffer } from "geotiff";

type Bounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  triangles: number;
};
type Template = { name: string; data: ArrayBuffer; bounds: Bounds };
const COLS = 4,
  ROWS = 4,
  GRID = 256,
  TILE_COUNT = COLS * ROWS,
  TILE_TOP_MM = 25,
  BOARD_TERRAIN_RIM_MM = 5,
  BOARD_CLEARANCE_MM = 0.125,
  TILE_FIELD_MM = COLS * TILE_TOP_MM,
  BOARD_TERRAIN_SIZE_MM = TILE_FIELD_MM + 2 * (BOARD_TERRAIN_RIM_MM + BOARD_CLEARANCE_MM),
  TILE_FIELD_INSET_MM = BOARD_TERRAIN_RIM_MM + BOARD_CLEARANCE_MM;
const APP_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type SavedProject = {
  version: 1;
  puzzleName: string;
  lat: string;
  lon: string;
  span: string;
  verticalModifier: string;
  elevationRangeM: number;
  elevationDatumM: number | null;
  terrainSpanKm: number;
  selected: number;
  placeholderIndex: number | null;
  placeholderIndices?: number[];
  elevation: number[];
  puzzleRows?: number;
  puzzleColumns?: number;
  activePuzzle?: number;
  joinedElevations?: number[][];
};

type ProjectFileHandle = {
  createWritable: () => Promise<{
    write: (data: string | ArrayBuffer) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

type ProjectDirectoryHandle = {
  name: string;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<ProjectFileHandle>;
};

type StoredProject = {
  project: SavedProject;
  directory?: ProjectDirectoryHandle;
  fileName?: string;
};

const PROJECT_DB_NAME = "terrain-puzzle-studio";
const PROJECT_STORE_NAME = "saved-project";
const PROJECT_STORE_KEY = "latest";

function boundsOfStl(buffer: ArrayBuffer): Bounds {
  const view = new DataView(buffer),
    faces = view.getUint32(80, true);
  if (buffer.byteLength !== 84 + faces * 50)
    throw new Error("Please choose a binary STL file.");
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < faces; i += 1) {
    let offset = 84 + i * 50 + 12;
    for (let point = 0; point < 3; point += 1) {
      const x = view.getFloat32(offset, true),
        y = view.getFloat32(offset + 4, true),
        z = view.getFloat32(offset + 8, true);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
      offset += 12;
    }
  }
  return { minX, minY, minZ, maxX, maxY, maxZ, triangles: faces };
}

async function loadBuiltInTemplate(path: string, name: string): Promise<Template> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load the built-in ${name}.`);
  const data = await response.arrayBuffer();
  return { name, data, bounds: boundsOfStl(data) };
}

function builtInAsset(name: string) {
  return `${APP_BASE_PATH}/${name}`;
}

function projectFileName(puzzleName: string) {
  return `${fileStem(puzzleName)}.terrain-puzzle.json`;
}

function openProjectStore() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PROJECT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROJECT_STORE_NAME))
        request.result.createObjectStore(PROJECT_STORE_NAME);
    };
    request.onerror = () => reject(request.error ?? new Error("Project storage is unavailable."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function rememberProject(record: StoredProject) {
  const database = await openProjectStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PROJECT_STORE_NAME, "readwrite");
      transaction.objectStore(PROJECT_STORE_NAME).put(record, PROJECT_STORE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Project could not be remembered."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Project storage was cancelled."));
    });
  } finally {
    database.close();
  }
}

async function rememberedProject() {
  const database = await openProjectStore();
  try {
    return await new Promise<StoredProject | null>((resolve, reject) => {
      const request = database
        .transaction(PROJECT_STORE_NAME, "readonly")
        .objectStore(PROJECT_STORE_NAME)
        .get(PROJECT_STORE_KEY);
      request.onsuccess = () => resolve((request.result as StoredProject | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("Saved project could not be read."));
    });
  } finally {
    database.close();
  }
}

function validSavedProject(input: unknown): SavedProject {
  const saved = input as Partial<SavedProject>;
  const puzzleRows =
      Number.isInteger(saved.puzzleRows) && (saved.puzzleRows as number) >= 1 && (saved.puzzleRows as number) <= 3
        ? (saved.puzzleRows as number)
        : 1,
    puzzleColumns =
      Number.isInteger(saved.puzzleColumns) && (saved.puzzleColumns as number) >= 1 && (saved.puzzleColumns as number) <= 3
        ? (saved.puzzleColumns as number)
        : 1,
    puzzleCount = puzzleRows * puzzleColumns,
    validBoard = (values: unknown): values is number[] =>
      Array.isArray(values) &&
      values.length === (GRID + 1) ** 2 &&
      values.every((value) => Number.isFinite(value)),
    savedBoards = Array.isArray(saved.joinedElevations) ? saved.joinedElevations : null,
    legacyPlaceholder =
      Number.isInteger(saved.placeholderIndex) &&
      (saved.placeholderIndex as number) >= 0 &&
      (saved.placeholderIndex as number) < TILE_COUNT
        ? (saved.placeholderIndex as number)
        : 12,
    placeholderIndices =
      Array.isArray(saved.placeholderIndices) &&
      saved.placeholderIndices.length === puzzleCount &&
      saved.placeholderIndices.every(
        (index) => Number.isInteger(index) && index >= 0 && index < TILE_COUNT,
      )
        ? saved.placeholderIndices
        : Array.from({ length: puzzleCount }, () => legacyPlaceholder);
  if (
    saved.version !== 1 ||
    !validBoard(saved.elevation) ||
    (savedBoards !== null &&
      (savedBoards.length !== puzzleCount || !savedBoards.every(validBoard)))
  )
    throw new Error("This is not a valid Terrain Puzzle project file.");
  const elevation = saved.elevation;
  return {
    version: 1,
    puzzleName: typeof saved.puzzleName === "string" ? saved.puzzleName : "terrain-puzzle",
    lat: typeof saved.lat === "string" ? saved.lat : "30.85274",
    lon: typeof saved.lon === "string" ? saved.lon : "34.78200",
    span: typeof saved.span === "string" ? saved.span : "10",
    verticalModifier: typeof saved.verticalModifier === "string" ? saved.verticalModifier : "1",
    elevationRangeM:
      Number.isFinite(saved.elevationRangeM) && (saved.elevationRangeM as number) > 0
        ? (saved.elevationRangeM as number)
        : 100,
    elevationDatumM:
      Number.isFinite(saved.elevationDatumM) ? (saved.elevationDatumM as number) : null,
    terrainSpanKm:
      Number.isFinite(saved.terrainSpanKm) && (saved.terrainSpanKm as number) > 0
        ? (saved.terrainSpanKm as number)
        : Number(saved.span) || 10,
    selected:
      Number.isInteger(saved.selected) && (saved.selected as number) >= 0 && (saved.selected as number) < TILE_COUNT
        ? (saved.selected as number)
        : 12,
    placeholderIndex:
      legacyPlaceholder,
    placeholderIndices,
    elevation,
    puzzleRows,
    puzzleColumns,
    activePuzzle:
      Number.isInteger(saved.activePuzzle) &&
      (saved.activePuzzle as number) >= 0 &&
      (saved.activePuzzle as number) < puzzleCount
        ? (saved.activePuzzle as number)
        : 0,
    joinedElevations: savedBoards ?? [elevation],
  };
}

function demoElevation(resolution = GRID) {
  const result: number[] = [];
  for (let y = 0; y <= resolution; y += 1)
    for (let x = 0; x <= resolution; x += 1) {
      const u = x / resolution,
        v = y / resolution;
      const ridge =
        Math.exp(-((u - 0.48) ** 2 * 32 + (v - 0.43) ** 2 * 6)) * 0.68;
      const shoulder =
        Math.exp(-((u - 0.18) ** 2 * 42 + (v - 0.71) ** 2 * 25)) * 0.36;
      result.push(
        Math.max(
          0,
          ridge + shoulder + 0.12 * Math.sin(u * 18 + v * 5) * Math.cos(v * 14),
        ),
      );
    }
  return result;
}

const DEFAULT_ELEVATION = demoElevation();

function repairElevationOutliers(values: number[], columns = GRID, rows = GRID) {
  // Elevation tiles can occasionally contain a single bad pixel. It becomes a
  // tall needle in a printed STL, so replace only values that disagree sharply
  // with every nearby sample. Two passes also catch a pair of adjacent pixels.
  let repaired = [...values];
  for (let pass = 0; pass < 2; pass += 1) {
    const source = repaired;
    repaired = [...source];
    for (let y = 1; y < rows; y += 1)
      for (let x = 1; x < columns; x += 1) {
        const nearby: number[] = [];
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx || dy) nearby.push(source[(y + dy) * (columns + 1) + x + dx]);
          }
        nearby.sort((a, b) => a - b);
        const middle = nearby[Math.floor(nearby.length / 2)],
          deviations = nearby.map((value) => Math.abs(value - middle)).sort((a, b) => a - b),
          medianDeviation = deviations[Math.floor(deviations.length / 2)],
          index = y * (columns + 1) + x,
          limit = Math.max(20, medianDeviation * 10);
        if (Math.abs(source[index] - middle) > limit) repaired[index] = middle;
      }
  }
  return repaired;
}

function sampleBoardTerrain(values: number[], eastMm: number, northMm: number) {
  const x = Math.max(0, Math.min(GRID, (eastMm / BOARD_TERRAIN_SIZE_MM) * GRID)),
    y = Math.max(0, Math.min(GRID, (1 - northMm / BOARD_TERRAIN_SIZE_MM) * GRID)),
    x0 = Math.floor(x),
    y0 = Math.floor(y),
    x1 = Math.min(GRID, x0 + 1),
    y1 = Math.min(GRID, y0 + 1),
    dx = x - x0,
    dy = y - y0,
    at = (gridX: number, gridY: number) => values[gridY * (GRID + 1) + gridX] ?? 0,
    top = at(x0, y0) * (1 - dx) + at(x1, y0) * dx,
    bottom = at(x0, y1) * (1 - dx) + at(x1, y1) * dx;
  return top * (1 - dy) + bottom * dy;
}

function sampleTileTerrain(
  values: number[],
  row: number,
  col: number,
  east: number,
  north: number,
) {
  return sampleBoardTerrain(
    values,
    TILE_FIELD_INSET_MM + col * TILE_TOP_MM + east * TILE_TOP_MM,
    TILE_FIELD_INSET_MM + (ROWS - row - 1) * TILE_TOP_MM + north * TILE_TOP_MM,
  );
}

function sampleBoardRimTerrain(values: number[], eastMm: number, northMm: number) {
  const innerRimEdge = BOARD_TERRAIN_RIM_MM,
    oppositeInnerRimEdge = BOARD_TERRAIN_SIZE_MM - BOARD_TERRAIN_RIM_MM,
    tileFieldEnd = TILE_FIELD_INSET_MM + TILE_FIELD_MM,
    matchTileEdge = (coordinate: number) => {
      // The board's inner terrain edge is 0.125 mm away from the tile field.
      // Sample exactly at the neighboring tile edge there, so separate printed
      // parts meet at the same height instead of showing a small step.
      if (Math.abs(coordinate - innerRimEdge) < 1e-6) return TILE_FIELD_INSET_MM;
      if (Math.abs(coordinate - oppositeInnerRimEdge) < 1e-6) return tileFieldEnd;
      return coordinate;
    };
  return sampleBoardTerrain(values, matchTileEdge(eastMm), matchTileEdge(northMm));
}

function flattestCorner(values: number[]) {
  const perTile = GRID / COLS,
    corners = [0, COLS - 1, (ROWS - 1) * COLS, TILE_COUNT - 1];
  const roughness = (index: number) => {
    const row = Math.floor(index / COLS),
      col = index % COLS;
    let total = 0;
    for (let y = 0; y < perTile; y += 1)
      for (let x = 0; x < perTile; x += 1) {
        const east = x / perTile,
          north = y / perTile,
          point = sampleTileTerrain(values, row, col, east, north);
        total += Math.abs(point - sampleTileTerrain(values, row, col, (x + 1) / perTile, north));
        total += Math.abs(point - sampleTileTerrain(values, row, col, east, (y + 1) / perTile));
      }
    return total;
  };
  return corners.reduce((flattest, candidate) =>
    roughness(candidate) < roughness(flattest) ? candidate : flattest,
  );
}

function readTriangles(buffer: ArrayBuffer) {
  const data = new DataView(buffer),
    faces = data.getUint32(80, true),
    triangles: number[][] = [];
  for (let i = 0; i < faces; i += 1) {
    const start = 84 + i * 50 + 12,
      tri: number[] = [];
    for (let j = 0; j < 9; j += 1)
      tri.push(data.getFloat32(start + j * 4, true));
    triangles.push(tri);
  }
  return triangles;
}
function normal(a: number[], b: number[], c: number[]) {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2],
    vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2],
    x = uy * vz - uz * vy,
    y = uz * vx - ux * vz,
    z = ux * vy - uy * vx,
    d = Math.hypot(x, y, z) || 1;
  return [x / d, y / d, z / d];
}
function binaryStl(triangles: number[][]) {
  const output = new ArrayBuffer(84 + triangles.length * 50),
    view = new DataView(output),
    title = new TextEncoder().encode("Terrain Puzzle Studio");
  new Uint8Array(output, 0, Math.min(80, title.length)).set(title.slice(0, 80));
  view.setUint32(80, triangles.length, true);
  triangles.forEach((tri, i) => {
    const offset = 84 + i * 50,
      n = normal(tri.slice(0, 3), tri.slice(3, 6), tri.slice(6, 9));
    n.forEach((value, index) =>
      view.setFloat32(offset + index * 4, value, true),
    );
    tri.forEach((value, index) =>
      view.setFloat32(offset + 12 + index * 4, value, true),
    );
    view.setUint16(offset + 48, 0, true);
  });
  return output;
}

function terrainTriangles(
  values: number[],
  row: number,
  col: number,
  bounds: Bounds,
  relief: number,
  terrainOnly: boolean,
  supportOverride?: number,
) {
  const perTile = GRID / COLS,
    // The puzzle connectors extend unevenly on two sides. Terrain belongs on
    // the centered 25 × 25 mm printable top, not the connector envelope.
    centerX = 0,
    centerY = 0,
    support =
      supportOverride ??
      (terrainOnly ? Math.max(bounds.minZ, 0) + 1.2 : bounds.maxZ - 0.25),
    floor = terrainOnly ? support - 1.2 : support - 0.18;
  // The selected map covers the entire 110.25 mm board. Each tile samples only
  // its 25 mm portion inside that board, leaving the surrounding data for the rim.
  const at = (x: number, y: number) =>
    sampleTileTerrain(values, row, col, x / perTile, y / perTile);
  const point = (x: number, y: number, bottom = false) => [
    centerX - TILE_TOP_MM / 2 + (TILE_TOP_MM * x) / perTile,
    centerY - TILE_TOP_MM / 2 + (TILE_TOP_MM * y) / perTile,
    bottom ? floor : support + 0.22 + at(x, y) * relief,
  ];
  const tris: number[][] = [],
    add = (a: number[], b: number[], c: number[]) =>
      tris.push([...a, ...b, ...c]);
  for (let y = 0; y < perTile; y += 1)
    for (let x = 0; x < perTile; x += 1) {
      const a = point(x, y),
        b = point(x + 1, y),
        c = point(x + 1, y + 1),
        d = point(x, y + 1),
        ab = point(x, y, true),
        bb = point(x + 1, y, true),
        cb = point(x + 1, y + 1, true),
        db = point(x, y + 1, true);
      add(a, b, c);
      add(a, c, d);
      add(ab, cb, bb);
      add(ab, db, cb);
      if (y === 0) {
        add(ab, b, bb);
        add(ab, a, b);
      }
      if (y === perTile - 1) {
        add(db, cb, c);
        add(db, c, d);
      }
      if (x === 0) {
        add(ab, db, d);
        add(ab, d, a);
      }
      if (x === perTile - 1) {
        add(bb, c, cb);
        add(bb, b, c);
      }
    }
  return tris;
}

function terrainPeak(
  values: number[],
  row: number,
  col: number,
  relief: number,
  support: number,
) {
  const perTile = GRID / COLS;
  let highest = 0;
  for (let y = 0; y <= perTile; y += 1)
    for (let x = 0; x <= perTile; x += 1)
      highest = Math.max(highest, sampleTileTerrain(values, row, col, x / perTile, y / perTile));
  return support + 0.22 + highest * relief;
}

function trimPlaceholderLetter(template: Template, terrainTop: number) {
  return readTriangles(template.data).map((triangle) =>
    triangle.map((value, index) =>
      index % 3 === 2 && Math.abs(value - template.bounds.maxZ) < 0.001
        ? terrainTop + 1
        : value,
    ),
  );
}

function terrainBoardTriangles(
  values: number[],
  bounds: Bounds,
  relief: number,
) {
  const width = bounds.maxX - bounds.minX,
    depth = bounds.maxY - bounds.minY,
    // Use the very same vertical construction as the tile terrain. The prior
    // board formula began 0.32 mm lower, creating a physical step at the rim.
    support = bounds.maxZ - 0.25,
    floor = support - 0.18,
    terrainBase = support + 0.22,
    rimX = BOARD_TERRAIN_RIM_MM / width,
    rimY = BOARD_TERRAIN_RIM_MM / depth;
  // Insert the physical inner rim edge into the mesh. A whole-grid-cell ring
  // would otherwise extend the 5 mm rim by up to one 0.43 mm sample cell.
  const axisWithRimEdge = (edge: number) =>
    Array.from({ length: GRID + 1 }, (_, index) => index)
      .concat(edge * GRID, GRID - edge * GRID)
      .sort((a, b) => a - b)
      .filter((value, index, axis) => index === 0 || value - axis[index - 1] > 1e-6);
  const xAxis = axisWithRimEdge(rimX),
    yAxis = axisWithRimEdge(rimY);
  const point = (x: number, y: number, bottom = false) => [
    bounds.minX + (width * x) / GRID,
    bounds.minY + (depth * y) / GRID,
    // All exported meshes use +Y as north. sampleBoardTerrain also powers
    // the map and canvas previews, keeping north/south identical everywhere.
    bottom
      ? floor
      : terrainBase +
        sampleBoardRimTerrain(
          values,
          (x / GRID) * BOARD_TERRAIN_SIZE_MM,
          (y / GRID) * BOARD_TERRAIN_SIZE_MM,
        ) *
          relief,
  ];
  const tris: number[][] = [],
    add = (a: number[], b: number[], c: number[]) =>
      tris.push([...a, ...b, ...c]);
  const isRing = (u: number, v: number) => {
    return u < rimX || u > 1 - rimX || v < rimY || v > 1 - rimY;
  };
  const isRingCell = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= xAxis.length - 1 || y >= yAxis.length - 1)
      return false;
    return isRing(
      (xAxis[x] + xAxis[x + 1]) / (2 * GRID),
      (yAxis[y] + yAxis[y + 1]) / (2 * GRID),
    );
  };
  for (let y = 0; y < yAxis.length - 1; y += 1)
    for (let x = 0; x < xAxis.length - 1; x += 1) {
      if (!isRingCell(x, y)) continue;
      const x0 = xAxis[x],
        x1 = xAxis[x + 1],
        y0 = yAxis[y],
        y1 = yAxis[y + 1],
        a = point(x0, y0),
        b = point(x1, y0),
        c = point(x1, y1),
        d = point(x0, y1),
        ab = point(x0, y0, true),
        bb = point(x1, y0, true),
        cb = point(x1, y1, true),
        db = point(x0, y1, true);
      add(a, b, c);
      add(a, c, d);
      add(ab, cb, bb);
      add(ab, db, cb);
      if (!isRingCell(x, y - 1)) {
        add(ab, b, bb);
        add(ab, a, b);
      }
      if (!isRingCell(x, y + 1)) {
        add(db, cb, c);
        add(db, c, d);
      }
      if (!isRingCell(x - 1, y)) {
        add(ab, db, d);
        add(ab, d, a);
      }
      if (!isRingCell(x + 1, y)) {
        add(bb, c, cb);
        add(bb, b, c);
      }
    }
  return tris;
}
function fileStem(name: string) {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return cleaned || "terrain-puzzle";
}

function terrainTile(zoom: number, x: number, y: number) {
  return new Promise<ImageData>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Canvas is unavailable."));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(context.getImageData(0, 0, 256, 256));
    };
    image.onerror = () =>
      reject(
        new Error(
          "High-resolution terrain tiles are unavailable for this area.",
        ),
      );
    image.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`;
  });
}

const tileX = (longitude: number, zoom: number) =>
  ((longitude + 180) / 360) * 2 ** zoom;
const tileY = (latitude: number, zoom: number) =>
  ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) *
  2 ** zoom;
const longitudeAt = (x: number, zoom: number) => (x / 2 ** zoom) * 360 - 180;
const latitudeAt = (y: number, zoom: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zoom))) * 180) / Math.PI;

function terrainRegion(
  latitude: number,
  longitude: number,
  widthKm: number,
  heightKm = widthKm,
) {
  const earthRadiusKm = 6371.0088,
    halfWidthAngle = widthKm / (2 * earthRadiusKm),
    halfHeightAngle = heightKm / (2 * earthRadiusKm),
    latitudeRadians = (latitude * Math.PI) / 180,
    latDelta = (halfHeightAngle * 180) / Math.PI,
    lonDelta =
      (Math.asin(Math.min(1, Math.sin(halfWidthAngle) / Math.max(0.001, Math.cos(latitudeRadians)))) *
        180) /
      Math.PI;
  return {
    minLat: latitude - latDelta,
    maxLat: latitude + latDelta,
    minLon: longitude - lonDelta,
    maxLon: longitude + lonDelta,
  };
}

async function elevationFromGeoTiff(
  buffer: ArrayBuffer,
  region: ReturnType<typeof terrainRegion>,
  columns = GRID,
  rows = GRID,
) {
  const tiff = await fromArrayBuffer(buffer),
    image = await tiff.getImage(),
    bounds = image.getBoundingBox(),
    geoKeys = image.getGeoKeys();
  const looksLikeWgs84 =
    geoKeys.GeographicTypeGeoKey === 4326 ||
    (Math.abs(bounds[0]) <= 180 &&
      Math.abs(bounds[2]) <= 180 &&
      Math.abs(bounds[1]) <= 90 &&
      Math.abs(bounds[3]) <= 90);
  if (!looksLikeWgs84)
    throw new Error(
      "This GeoTIFF is not in WGS84 latitude/longitude. Export it as EPSG:4326 first.",
    );
  if (
    region.minLon < bounds[0] ||
    region.maxLon > bounds[2] ||
    region.minLat < bounds[1] ||
    region.maxLat > bounds[3]
  )
    throw new Error(
      "The selected square is outside the uploaded GeoTIFF. Move the square inside the DEM coverage.",
    );
  const raster = await image.readRasters({
    bbox: [region.minLon, region.minLat, region.maxLon, region.maxLat],
    width: columns + 1,
    height: rows + 1,
    resampleMethod: "bilinear",
    interleave: true,
  });
  const bands = image.getSamplesPerPixel(),
    values: number[] = [];
  for (let index = 0; index < raster.length; index += bands)
    values.push(Number(raster[index]));
  return values;
}

function MapPicker({
  latitude,
  longitude,
  areaKm,
  puzzleRows,
  puzzleColumns,
  onPick,
}: {
  latitude: number;
  longitude: number;
  areaKm: number;
  puzzleRows: number;
  puzzleColumns: number;
  onPick: (latitude: number, longitude: number) => void;
}) {
  const [zoom, setZoom] = useState(11),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<
      { display_name: string; lat: string; lon: string }[]
    >([]),
    [searching, setSearching] = useState(false),
    [view, setView] = useState({ latitude, longitude }),
    [fullscreen, setFullscreen] = useState(false);
  const drag = useRef<{
    x: number;
    y: number;
    viewX: number;
    viewY: number;
    moved: boolean;
  } | null>(null);
  useEffect(() => {
    if (fullscreen) return;
    const frame = requestAnimationFrame(() =>
      setView({ latitude, longitude }),
    );
    return () => cancelAnimationFrame(frame);
  }, [fullscreen, latitude, longitude]);
  const x = tileX(view.longitude, zoom),
    y = tileY(view.latitude, zoom),
    selectedX = tileX(longitude, zoom),
    selectedY = tileY(latitude, zoom);
  const tiles = useMemo(
    () =>
      Array.from({ length: (fullscreen ? 9 : 5) ** 2 }, (_, i) => {
        const radius = fullscreen ? 4 : 2,
          width = radius * 2 + 1,
          dx = (i % width) - radius,
          dy = Math.floor(i / width) - radius,
          tx = Math.floor(x) + dx,
          ty = Math.floor(y) + dy;
        return { id: `${zoom}-${tx}-${ty}`, tx, ty };
      }),
    [fullscreen, x, y, zoom],
  );
  const selectedLeft = (selectedX - x) * 256,
    selectedTop = (selectedY - y) * 256,
    metresPerPixel =
      (40075016.686 * Math.max(0.2, Math.cos((latitude * Math.PI) / 180))) /
      (256 * 2 ** zoom),
    // Web Mercator is locally conformal. The selection shows the real full
    // joined layout size, including every connected puzzle board.
    selectionWidth = (areaKm * puzzleColumns * 1000) / metresPerPixel,
    selectionHeight = (areaKm * puzzleRows * 1000) / metresPerPixel,
    selectionLeft = selectedLeft - selectionWidth / 2,
    selectionTop = selectedTop - selectionHeight / 2,
    stepKm = Math.max(0.01, (metresPerPixel * 16) / 1000);
  function setZoomAround(delta: number) {
    setZoom((current) => Math.max(5, Math.min(16, current + delta)));
  }
  function pointAt(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect(),
      mapX = x + (event.clientX - rect.left - rect.width / 2) / 256,
      mapY = y + (event.clientY - rect.top - rect.height / 2) / 256;
    return { latitude: latitudeAt(mapY, zoom), longitude: longitudeAt(mapX, zoom) };
  }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!fullscreen) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, viewX: x, viewY: y, moved: false };
  }
  function dragMap(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!fullscreen || !current) return;
    const dx = event.clientX - current.x,
      dy = event.clientY - current.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) current.moved = true;
    setView({
      longitude: longitudeAt(current.viewX - dx / 256, zoom),
      latitude: latitudeAt(current.viewY - dy / 256, zoom),
    });
  }
  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    drag.current = null;
    if (!fullscreen || !current || current.moved) return;
    const point = pointAt(event);
    onPick(point.latitude, point.longitude);
  }
  function move(direction: "north" | "south" | "east" | "west") {
    const latStep = stepKm / 111.32,
      lonStep =
        stepKm / (111.32 * Math.max(0.2, Math.cos((latitude * Math.PI) / 180)));
    onPick(
      latitude +
        (direction === "north"
          ? latStep
          : direction === "south"
            ? -latStep
            : 0),
      longitude +
        (direction === "east" ? lonStep : direction === "west" ? -lonStep : 0),
    );
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`,
        { headers: { Accept: "application/json" } },
      );
      if (!response.ok) throw new Error();
      setResults(await response.json());
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }
  const surface = (isFullscreen: boolean) => (
    <div
      className={`mapSurface ${isFullscreen ? "mapSurfaceFullscreen" : ""}`}
      role="application"
      aria-label={isFullscreen ? "Topographic map. Drag to pan, scroll to zoom, click to choose terrain." : "Topographic map with the selected square."}
      onWheel={
        isFullscreen
          ? (event) => {
              event.preventDefault();
              setZoomAround(event.deltaY < 0 ? 1 : -1);
            }
          : undefined
      }
      onPointerDown={startDrag}
      onPointerMove={dragMap}
      onPointerUp={finishDrag}
    >
      {tiles.map((t) => (
        <img
          key={t.id}
          src={`https://${["a", "b", "c"][Math.abs(t.tx + t.ty) % 3]}.tile.opentopomap.org/${zoom}/${t.tx}/${t.ty}.png`}
          alt=""
          draggable="false"
          style={{
            left: `calc(50% + ${(t.tx - x) * 256}px)`,
            top: `calc(50% + ${(t.ty - y) * 256}px)`,
          }}
        />
      ))}
      <span
        className="areaBox"
        style={{
          width: selectionWidth,
          height: selectionHeight,
          left: `calc(50% + ${selectionLeft}px)`,
          top: `calc(50% + ${selectionTop}px)`,
        }}
      />
      <span
        className="mapPin"
        style={{
          left: `calc(50% + ${selectedLeft}px)`,
          top: `calc(50% + ${selectedTop}px)`,
        }}
      >
        ●
      </span>
      <span className="mapAttribution">© OpenTopoMap · © OpenStreetMap</span>
    </div>
  );
  return (
    <div className="mapPicker">
      <form className="mapSearch" onSubmit={search}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search any place"
          aria-label="Search any place"
        />
        <button type="submit">{searching ? "…" : "Search"}</button>
      </form>
      {results.length > 0 && (
        <div className="searchResults">
          {results.map((result) => (
            <button
              type="button"
              key={`${result.lat}-${result.lon}`}
              onClick={() => {
                const next = {
                  latitude: Number(result.lat),
                  longitude: Number(result.lon),
                };
                onPick(next.latitude, next.longitude);
                setView(next);
                setQuery(result.display_name);
                setResults([]);
              }}
            >
              {result.display_name}
            </button>
          ))}
        </div>
      )}
      {surface(false)}
      <div className="mapZoom">
        <button
          type="button"
          onClick={() => setZoomAround(1)}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setZoomAround(-1)}
          aria-label="Zoom out"
        >
          −
        </button>
      </div>
      <div className="movePad" aria-label="Move terrain square">
        <button
          type="button"
          onClick={() => move("north")}
          aria-label="Move square north"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => move("west")}
          aria-label="Move square west"
        >
          ←
        </button>
        <button
          type="button"
          onClick={() => move("south")}
          aria-label="Move square south"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={() => move("east")}
          aria-label="Move square east"
        >
          →
        </button>
      </div>
      <p>
        Arrow step follows the zoom: {" "}
        {stepKm < 1
          ? `${Math.round(stepKm * 1000)} m`
          : `${stepKm.toFixed(1)} km`}
        . Use the full-screen map when you want to pan freely.
      </p>
      <button className="fullMapButton" type="button" onClick={() => setFullscreen(true)}>
        Open full-screen map
      </button>
      {fullscreen && (
        <div className="mapFullscreen" role="dialog" aria-modal="true" aria-label="Full-screen topographic map">
          <div className="mapFullscreenBar">
            <b>Topographic map</b>
            <span>Drag to pan · scroll to zoom · click to choose the square</span>
            <button type="button" onClick={() => setFullscreen(false)}>Close map</button>
          </div>
          {surface(true)}
        </div>
      )}
    </div>
  );
}

function TilePreview({
  index,
  selected,
  placeholder,
  values,
  onClick,
}: {
  index: number;
  selected: boolean;
  placeholder: boolean;
  values: number[];
  onClick: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    row = Math.floor(index / COLS),
    col = index % COLS;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const size = 120;
    el.width = size;
    el.height = size;
    const context = el.getContext("2d");
    if (!context) return;
    const image = context.createImageData(size, size);
    const shade = (u: number, v: number) => {
      const h = sampleTileTerrain(values, row, col, u, 1 - v),
        n = Math.max(0, Math.min(1, h));
      return [22 + n * 18, 89 + n * 70, 87 + n * 52];
    };
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        const [r, g, b] = shade(x / size, y / size),
          p = (y * size + x) * 4;
        image.data[p] = r;
        image.data[p + 1] = g;
        image.data[p + 2] = b;
        image.data[p + 3] = 255;
      }
    context.putImageData(image, 0, 0);
    context.globalAlpha = 0.22;
    context.strokeStyle = "#d9e9df";
    for (let i = 9; i < size; i += 14) {
      context.beginPath();
      context.moveTo(0, i);
      context.quadraticCurveTo(size * 0.5, i - 8, size, i);
      context.stroke();
    }
    context.globalAlpha = 1;
  }, [col, row, values]);
  return (
    <button
      className={`tile ${selected ? "selected" : ""} ${placeholder ? "placeholder" : ""}`}
      onClick={onClick}
      aria-label={`Tile ${row + 1}, ${col + 1}`}
    >
      <canvas ref={canvas} />
      <span className="tileTag">
        {row + 1}.{col + 1}
      </span>
      {placeholder && <span className="placeholderTag">צ</span>}
    </button>
  );
}

function BoardRimPreview({ values }: { values: number[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const size = 360;
    el.width = size;
    el.height = size;
    const context = el.getContext("2d");
    if (!context) return;
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        const h = Math.max(
            0,
            Math.min(
              1,
              sampleBoardRimTerrain(
                values,
                (x / size) * BOARD_TERRAIN_SIZE_MM,
                (1 - y / size) * BOARD_TERRAIN_SIZE_MM,
              ),
            ),
          ),
          p = (y * size + x) * 4;
        image.data[p] = 22 + h * 18;
        image.data[p + 1] = 89 + h * 70;
        image.data[p + 2] = 87 + h * 52;
        image.data[p + 3] = 255;
      }
    context.putImageData(image, 0, 0);
    context.globalAlpha = 0.22;
    context.strokeStyle = "#d9e9df";
    for (let i = 12; i < size; i += 18) {
      context.beginPath();
      context.moveTo(0, i);
      context.quadraticCurveTo(size * 0.5, i - 10, size, i);
      context.stroke();
    }
    context.globalAlpha = 1;
  }, [values]);
  return <canvas ref={canvas} className="boardRimPreview" aria-hidden="true" />;
}

function TerrainViewer({
  values,
  relief,
  modifier,
  onClose,
}: {
  values: number[];
  relief: number;
  modifier: string;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    drag = useRef<{ x: number; yaw: number } | null>(null),
    [yaw, setYaw] = useState(-0.8),
    [zoom, setZoom] = useState(1);
  useEffect(() => {
    const htmlOverflow = document.documentElement.style.overflow,
      bodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = htmlOverflow;
      document.body.style.overflow = bodyOverflow;
    };
  }, []);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const rect = el.getBoundingClientRect(),
      ratio = Math.min(2, window.devicePixelRatio || 1),
      width = Math.max(1, Math.round(rect.width * ratio)),
      height = Math.max(1, Math.round(rect.height * ratio));
    el.width = width;
    el.height = height;
    const context = el.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    context.fillStyle = "#e8f2ed";
    context.fillRect(0, 0, rect.width, rect.height);
    const cells = 40,
      step = GRID / cells,
      scale = (Math.min(rect.width, rect.height) / (BOARD_TERRAIN_SIZE_MM * 1.1)) * zoom,
      cos = Math.cos(yaw),
      sin = Math.sin(yaw),
      // The printable mesh remains unchanged. This small weighted average only
      // makes the interactive display easy to read instead of showing every
      // raw DEM sample as a sharp visual spike.
      smoothHeight = (gridX: number, gridY: number) => {
        let total = 0,
          weight = 0;
        const centerX = Math.round(gridX),
          centerY = Math.round(GRID - gridY);
        for (let dy = -3; dy <= 3; dy += 1)
          for (let dx = -3; dx <= 3; dx += 1) {
            const x = Math.max(0, Math.min(GRID, centerX + dx)),
              y = Math.max(0, Math.min(GRID, centerY + dy)),
              w = 4 - Math.max(Math.abs(dx), Math.abs(dy));
            total += (values[y * (GRID + 1) + x] ?? 0) * w;
            weight += w;
          }
        return total / Math.max(1, weight);
      },
      point = (gridX: number, gridY: number) => {
        const x = (gridX / GRID - 0.5) * BOARD_TERRAIN_SIZE_MM,
          north = (0.5 - gridY / GRID) * BOARD_TERRAIN_SIZE_MM,
          heightMm = smoothHeight(gridX, gridY) * relief,
          side = x * cos - north * sin,
          depth = x * sin + north * cos;
        return {
          x: rect.width / 2 + side * scale,
          y: rect.height * 0.62 + depth * scale * 0.35 - heightMm * scale,
          depth,
          heightMm,
        };
      };
    const faces: { points: ReturnType<typeof point>[]; depth: number; shade: number }[] = [];
    for (let y = 0; y < cells; y += 1)
      for (let x = 0; x < cells; x += 1) {
        const a = point(x * step, y * step),
          b = point((x + 1) * step, y * step),
          c = point((x + 1) * step, (y + 1) * step),
          d = point(x * step, (y + 1) * step),
          averageHeight = (a.heightMm + b.heightMm + c.heightMm + d.heightMm) / 4;
        faces.push({
          points: [a, b, c, d],
          depth: (a.depth + b.depth + c.depth + d.depth) / 4,
          shade: Math.min(1, averageHeight / Math.max(0.01, relief)),
        });
      }
    faces.sort((a, b) => a.depth - b.depth);
    for (const face of faces) {
      const [a, ...rest] = face.points;
      context.beginPath();
      context.moveTo(a.x, a.y);
      for (const p of rest) context.lineTo(p.x, p.y);
      context.closePath();
      const light = Math.round(31 + face.shade * 28);
      context.fillStyle = `rgb(${17 + Math.round(face.shade * 22)}, ${light + 48}, ${light + 39})`;
      context.fill();
    }
  }, [relief, values, yaw, zoom]);
  return (
    <div className="terrainViewer" role="dialog" aria-modal="true" aria-label="3D terrain viewer">
      <div className="viewerPanel">
        <div className="viewerHead">
          <div>
            <p className="eyebrow">LIVE TERRAIN PREVIEW</p>
            <h2>3D terrain model</h2>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <canvas
          className="viewerCanvas"
          ref={canvas}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, yaw };
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            setYaw(drag.current.yaw - (event.clientX - drag.current.x) / 180);
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onWheel={(event) => {
            event.preventDefault();
            setZoom((current) => Math.max(0.65, Math.min(1.7, current + (event.deltaY < 0 ? 0.1 : -0.1))));
          }}
        />
        <div className="viewerFooter">
          <span>Height modifier ×{modifier}</span>
          <b>{relief.toFixed(2)} mm maximum relief</b>
          <small>Smooth display preview · drag to rotate · scroll to zoom</small>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [tile, setTile] = useState<Template | null>(null),
    [board, setBoard] = useState<Template | null>(null),
    [placeholder, setPlaceholder] = useState<Template | null>(null),
    [dem, setDem] = useState<{ name: string; data: ArrayBuffer } | null>(null),
    [elevation, setElevation] = useState(DEFAULT_ELEVATION),
    [elevationRangeM, setElevationRangeM] = useState(100),
    [elevationDatumM, setElevationDatumM] = useState<number | null>(null),
    [terrainSpanKm, setTerrainSpanKm] = useState(10),
    [puzzleRows, setPuzzleRows] = useState(1),
    [puzzleColumns, setPuzzleColumns] = useState(1),
    [activePuzzle, setActivePuzzle] = useState(0),
    [joinedElevations, setJoinedElevations] = useState<number[][]>([DEFAULT_ELEVATION]),
    [selected, setSelected] = useState(12),
    [placeholderIndex, setPlaceholderIndex] = useState(() =>
      flattestCorner(DEFAULT_ELEVATION),
    ),
    [placeholderIndices, setPlaceholderIndices] = useState(() => [flattestCorner(DEFAULT_ELEVATION)]),
    [lat, setLat] = useState("30.85274"),
    [lon, setLon] = useState("34.78200"),
    [span, setSpan] = useState("10"),
    [verticalModifier, setVerticalModifier] = useState("1"),
    [puzzleName, setPuzzleName] = useState("terrain-puzzle"),
    [projectFolder, setProjectFolder] = useState<ProjectDirectoryHandle | null>(null),
    [projectFolderName, setProjectFolderName] = useState(""),
    [readyDownload, setReadyDownload] = useState<{ name: string; url: string } | null>(null),
    [readyProjectSave, setReadyProjectSave] = useState<{ name: string; url: string } | null>(null),
    [viewerOpen, setViewerOpen] = useState(false),
    [status, setStatus] = useState(
      "Ein Avdat / Nahal Zin preview is ready. Fetch the terrain to begin.",
    );
  const tileBounds = tile?.bounds ?? {
      minX: -12.5,
      maxX: 12.5,
      minY: -12.5,
      maxY: 12.5,
      minZ: 0,
      maxZ: 5,
      triangles: 0,
    },
    selectedRow = Math.floor(selected / COLS) + 1,
    selectedCol = (selected % COLS) + 1,
    selectedPlaceholder = placeholderIndices[activePuzzle] === selected,
    activePuzzleRow = Math.floor(activePuzzle / puzzleColumns) + 1,
    activePuzzleColumn = (activePuzzle % puzzleColumns) + 1,
    joinedPuzzleCount = puzzleRows * puzzleColumns,
    trueScaleRelief =
      (elevationRangeM / Math.max(0.1, terrainSpanKm * 1000)) *
      BOARD_TERRAIN_SIZE_MM,
    effectiveRelief =
      trueScaleRelief * Math.max(0.1, Number(verticalModifier) || 1);
  const projectSnapshot = useCallback(
      (): SavedProject => ({
        version: 1,
        puzzleName,
        lat,
        lon,
        span,
        verticalModifier,
        elevationRangeM,
        elevationDatumM,
        terrainSpanKm,
        selected,
        placeholderIndex,
        placeholderIndices,
        elevation,
        puzzleRows,
        puzzleColumns,
        activePuzzle,
        joinedElevations,
      }),
      [
        elevation,
        elevationRangeM,
        elevationDatumM,
        lat,
        lon,
        placeholderIndex,
        placeholderIndices,
        puzzleName,
        selected,
        activePuzzle,
        span,
        terrainSpanKm,
        verticalModifier,
        puzzleColumns,
        puzzleRows,
        joinedElevations,
      ],
    ),
    applySavedProject = useCallback((saved: SavedProject, message: string) => {
      setPuzzleName(saved.puzzleName);
      setLat(saved.lat);
      setLon(saved.lon);
      setSpan(saved.span);
      setVerticalModifier(saved.verticalModifier);
      setElevationRangeM(saved.elevationRangeM);
      setElevationDatumM(saved.elevationDatumM);
      setTerrainSpanKm(saved.terrainSpanKm);
      setPuzzleRows(saved.puzzleRows ?? 1);
      setPuzzleColumns(saved.puzzleColumns ?? 1);
      setActivePuzzle(saved.activePuzzle ?? 0);
      setSelected(saved.selected);
      setPlaceholderIndex(saved.placeholderIndex ?? 12);
      setPlaceholderIndices(saved.placeholderIndices ?? [saved.placeholderIndex ?? 12]);
      setElevation(saved.elevation);
      setJoinedElevations(saved.joinedElevations ?? [saved.elevation]);
      setStatus(message);
    }, []);
  useEffect(() => {
    let cancelled = false;
    async function loadTemplates() {
      try {
        const [builtInTile, builtInBoard, builtInPlaceholder] = await Promise.all([
          loadBuiltInTemplate(builtInAsset("tile.stl"), "Built-in puzzle tile"),
          loadBuiltInTemplate(builtInAsset("board.stl"), "Built-in puzzle board"),
          loadBuiltInTemplate(builtInAsset("placeholder.stl"), "Built-in placeholder tile"),
        ]);
        if (cancelled) return;
        setTile(builtInTile);
        setBoard(builtInBoard);
        setPlaceholder(builtInPlaceholder);
        setStatus("Your built-in puzzle and placeholder tiles are ready.");
      } catch (error) {
        if (!cancelled)
          setStatus(
            error instanceof Error
              ? error.message
              : "The built-in templates could not be loaded.",
          );
      }
    }
    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    async function restoreProject() {
      try {
        const stored = await rememberedProject();
        if (!stored) return;
        const saved = validSavedProject(stored.project);
        if (cancelled) return;
        applySavedProject(saved, "Your last saved project was restored automatically.");
        if (stored.directory) {
          setProjectFolder(stored.directory);
          setProjectFolderName(stored.directory.name);
        }
      } catch {
        // A missing or older browser record should never prevent the builder loading.
      }
    }
    void restoreProject();
    return () => {
      cancelled = true;
    };
  }, [applySavedProject]);
  // This remains available for loading an existing local GeoTIFF project.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function pickDem(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setDem({ name: file.name, data: await file.arrayBuffer() });
      setStatus(`${file.name} is ready. Fetch terrain to use its elevations.`);
    } catch {
      setStatus("That GeoTIFF could not be read.");
    }
  }
  async function fetchElevation() {
    const latitude = Number(lat),
      longitude = Number(lon),
      kilometres = Math.max(0.1, Number(span)),
      sampleColumns = GRID * puzzleColumns,
      sampleRows = GRID * puzzleRows;
    if (![latitude, longitude, kilometres].every(Number.isFinite)) {
      setStatus("Enter a valid latitude, longitude, and area width.");
      return;
    }
    setStatus(
      dem
        ? "Reading your high-detail GeoTIFF and slicing the model…"
        : "Loading terrain and slicing the model…",
    );
    try {
      const region = terrainRegion(
          latitude,
          longitude,
          kilometres * puzzleColumns,
          kilometres * puzzleRows,
        ),
        { minLat, maxLat, minLon, maxLon } = region;
      let samples: number[];
      if (dem) samples = await elevationFromGeoTiff(dem.data, region, sampleColumns, sampleRows);
      else {
        let zoom =
          kilometres <= 2
            ? 15
            : kilometres <= 5
              ? 14
              : kilometres <= 12
                ? 13
                : kilometres <= 30
                  ? 12
                  : kilometres <= 80
                    ? 11
                    : kilometres <= 160
                      ? 10
                      : 9;
        let keys: { x: number; y: number }[] = [];
        // Use the most detailed source zoom that fits safely in one request.
        // Larger map areas automatically step down only as far as necessary.
        while (true) {
          const minX = tileX(minLon, zoom),
            maxX = tileX(maxLon, zoom),
            minY = tileY(maxLat, zoom),
            maxY = tileY(minLat, zoom);
          keys = [];
          for (let y = Math.floor(minY) - 1; y <= Math.floor(maxY) + 1; y += 1)
            for (let x = Math.floor(minX) - 1; x <= Math.floor(maxX) + 1; x += 1)
              keys.push({ x, y });
          if (keys.length <= 36 || zoom <= 6) break;
          zoom -= 1;
        }
        const tiles = new Map<string, ImageData>();
        await Promise.all(
          keys.map(async (key) =>
            tiles.set(
              `${key.x}/${key.y}`,
              await terrainTile(zoom, key.x, key.y),
            ),
          ),
        );
        const pixelElevation = (pixelX: number, pixelY: number) => {
          const tx = Math.floor(pixelX / 256),
            ty = Math.floor(pixelY / 256),
            px = ((Math.floor(pixelX) % 256) + 256) % 256,
            py = ((Math.floor(pixelY) % 256) + 256) % 256;
          const data = tiles.get(`${tx}/${ty}`);
          if (!data) throw new Error("Terrain tile missing.");
          const offset = (py * 256 + px) * 4;
          return (
            data.data[offset] * 256 +
            data.data[offset + 1] +
            data.data[offset + 2] / 256 -
            32768
          );
        };
        samples = [];
        for (let row = 0; row <= sampleRows; row += 1)
          for (let col = 0; col <= sampleColumns; col += 1) {
            const sampleLat = maxLat - ((maxLat - minLat) * row) / sampleRows,
              sampleLon = minLon + ((maxLon - minLon) * col) / sampleColumns;
            const pixelX = tileX(sampleLon, zoom) * 256,
              pixelY = tileY(sampleLat, zoom) * 256,
              x0 = Math.floor(pixelX),
              y0 = Math.floor(pixelY),
              fx = pixelX - x0,
              fy = pixelY - y0;
            const top =
              pixelElevation(x0, y0) * (1 - fx) +
              pixelElevation(x0 + 1, y0) * fx;
            const bottom =
              pixelElevation(x0, y0 + 1) * (1 - fx) +
              pixelElevation(x0 + 1, y0 + 1) * fx;
            samples.push(top * (1 - fy) + bottom * fy);
          }
      }
      samples = repairElevationOutliers(samples, sampleColumns, sampleRows);
      const low = Math.min(...samples),
        high = Math.max(...samples),
        range = Math.max(1, high - low),
        normalized = samples.map((value) => (value - low) / range),
        boards = Array.from({ length: puzzleRows * puzzleColumns }, (_, boardIndex) => {
          const boardRow = Math.floor(boardIndex / puzzleColumns),
            boardColumn = boardIndex % puzzleColumns,
            result: number[] = [];
          for (let row = 0; row <= GRID; row += 1)
            for (let col = 0; col <= GRID; col += 1)
              result.push(
                normalized[
                  (boardRow * GRID + row) * (sampleColumns + 1) +
                    boardColumn * GRID +
                    col
                ],
              );
          return result;
        });
      setJoinedElevations(boards);
      setActivePuzzle(0);
      setElevation(boards[0]);
      setElevationRangeM(range);
      setElevationDatumM(low);
      setTerrainSpanKm(kilometres);
      setPlaceholderIndex(flattestCorner(boards[0]));
      setPlaceholderIndices(boards.map((boardElevation) => flattestCorner(boardElevation)));
      setStatus(
        `Continuous terrain loaded: ${Math.round(low)}–${Math.round(high)} m across ${puzzleRows} × ${puzzleColumns} joined puzzle${puzzleRows * puzzleColumns > 1 ? "s" : ""}. Each board has its own placeholder; shared edges use the same elevation samples.`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Terrain could not be loaded.",
      );
    }
  }
  function movePlaceholder() {
    if (!placeholder) {
      setStatus("The built-in placeholder tile is still loading.");
      return;
    }
    setPlaceholderIndex(selected);
    setPlaceholderIndices((current) =>
      Array.from({ length: joinedPuzzleCount }, (_, index) =>
        index === activePuzzle ? selected : current[index] ?? flattestCorner(elevation),
      ),
    );
    setStatus(
      `Placeholder moved to puzzle ${activePuzzleRow}.${activePuzzleColumn}, tile ${selectedRow}.${selectedCol}. Its צ stays 1 mm above this tile's highest terrain.`,
    );
  }
  function choosePuzzle(index: number) {
    const nextElevation = joinedElevations[index];
    if (!nextElevation) return;
    setActivePuzzle(index);
    setElevation(nextElevation);
    setSelected(12);
    setStatus(`Editing joined puzzle ${Math.floor(index / puzzleColumns) + 1}.${(index % puzzleColumns) + 1}.`);
  }
  function adjustArea(delta: number) {
    setSpan((current) => {
      const next = Math.min(
        200,
        Math.max(0.1, Math.round(((Number(current) || 2) + delta) * 10) / 10),
      );
      return String(next);
    });
  }
  function changeJoinedLayout(rows: number, columns: number) {
    const boardCount = rows * columns;
    setPuzzleRows(rows);
    setPuzzleColumns(columns);
    setActivePuzzle(0);
    setJoinedElevations(Array.from({ length: boardCount }, () => DEFAULT_ELEVATION));
    setElevation(DEFAULT_ELEVATION);
    setPlaceholderIndex(flattestCorner(DEFAULT_ELEVATION));
    setPlaceholderIndices(
      Array.from({ length: boardCount }, () => flattestCorner(DEFAULT_ELEVATION)),
    );
    setStatus(`Joined layout set to ${rows} × ${columns}. Fetch terrain to make one continuous map across all ${boardCount} board${boardCount > 1 ? "s" : ""}.`);
  }
  async function writeProjectToFolder(
    directory: ProjectDirectoryHandle,
    project: SavedProject,
  ) {
    const fileName = projectFileName(project.puzzleName),
      file = await directory.getFileHandle(fileName, { create: true }),
      writable = await file.createWritable();
    try {
      await writable.write(JSON.stringify(project, null, 2));
    } finally {
      await writable.close();
    }
    await rememberProject({ project, directory, fileName });
    setProjectFolder(directory);
    setProjectFolderName(directory.name);
    setStatus(`Project saved to “${directory.name}”. It will reopen automatically after refresh.`);
  }
  async function downloadProjectFallback(project: SavedProject) {
    await rememberProject({ project });
    if (readyProjectSave) URL.revokeObjectURL(readyProjectSave.url);
    const bytes = new TextEncoder().encode(JSON.stringify(project, null, 2)),
      fileName = projectFileName(project.puzzleName);
    setReadyProjectSave({
      name: fileName,
      url: URL.createObjectURL(new Blob([bytes], { type: "application/json" })),
    });
    setStatus(
      "Your project is ready. Click “Save project file” below to download it; it will also reopen automatically after refresh.",
    );
  }
  async function chooseProjectFolder(): Promise<ProjectDirectoryHandle | null | undefined> {
    const pickerWindow = window as Window & {
      showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<ProjectDirectoryHandle>;
    };
    if (!pickerWindow.showDirectoryPicker) return null;
    try {
      return await pickerWindow.showDirectoryPicker({
        id: "terrain-puzzle-projects",
        mode: "readwrite",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return undefined;
      return null;
    }
  }
  async function chooseProjectFolderAndSave() {
    const directory = await chooseProjectFolder();
    if (directory === undefined) return;
    if (!directory) {
      try {
        await downloadProjectFallback(projectSnapshot());
      } catch {
        setStatus("The project folder could not be used. Choose it again and allow read/write access.");
      }
      return;
    }
    await writeProjectToFolder(directory, projectSnapshot());
  }
  async function saveProject() {
    await chooseProjectFolderAndSave();
  }
  async function folderForStlExport(): Promise<ProjectDirectoryHandle | null | undefined> {
    const directory = await chooseProjectFolder();
    if (!directory) return directory;
    const project = projectSnapshot();
    setProjectFolder(directory);
    setProjectFolderName(directory.name);
    try {
      await rememberProject({
        project,
        directory,
        fileName: projectFileName(project.puzzleName),
      });
    } catch {
      // STL saving can still work if local browser memory is unavailable.
    }
    return directory;
  }
  function browserCanChooseFolder() {
    return typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
  }
  async function saveStlFile(
    fileName: string,
    data: ArrayBuffer,
    folder: ProjectDirectoryHandle,
  ) {
    try {
      const file = await folder.getFileHandle(fileName, { create: true }),
        writable = await file.createWritable();
      try {
        await writable.write(data);
      } finally {
        await writable.close();
      }
      return true;
    } catch {
      return false;
    }
  }
  async function loadProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const saved = validSavedProject(JSON.parse(await file.text()));
      await rememberProject({
        project: saved,
        ...(projectFolder
          ? { directory: projectFolder, fileName: projectFileName(saved.puzzleName) }
          : {}),
      });
      applySavedProject(saved, `Project “${file.name}” loaded and will reopen automatically after refresh.`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Project file could not be loaded.",
      );
    } finally {
      event.target.value = "";
    }
  }
  function tileExport(
    index: number,
    boardIndex = activePuzzle,
    boardElevation = elevation,
  ) {
    const boardRow = Math.floor(boardIndex / puzzleColumns) + 1,
      boardColumn = (boardIndex % puzzleColumns) + 1,
      isPlaceholder = placeholderIndices[boardIndex] === index && Boolean(placeholder),
      row = Math.floor(index / COLS),
      col = index % COLS,
      source = isPlaceholder ? placeholder : tile,
      sourceBounds = isPlaceholder && placeholder ? placeholder.bounds : tileBounds,
      support = isPlaceholder ? 0 : undefined,
      terrain = terrainTriangles(
        boardElevation,
        row,
        col,
        sourceBounds,
        effectiveRelief,
        false,
        support,
      ),
      sourceTriangles =
        isPlaceholder && placeholder
          ? trimPlaceholderLetter(
              placeholder,
              terrainPeak(boardElevation, row, col, effectiveRelief, 0),
            )
          : source
            ? readTriangles(source.data)
            : [],
      combined = !source ? terrain : [...sourceTriangles, ...terrain];
    return {
      row,
      col,
      fileName: `${fileStem(puzzleName)}-puzzle-r${boardRow}-c${boardColumn}-tile-r${row + 1}-c${col + 1}${isPlaceholder ? "-placeholder" : ""}.stl`,
      data: binaryStl(combined),
    };
  }
  function stageDownload(fileName: string, data: ArrayBuffer) {
    if (readyDownload) URL.revokeObjectURL(readyDownload.url);
    setReadyDownload({
      name: fileName,
      url: URL.createObjectURL(new Blob([data], { type: "model/stl" })),
    });
  }
  function stageTileDownload(index: number) {
    try {
      const exported = tileExport(index);
      stageDownload(exported.fileName, exported.data);
      setStatus(`Tile ${exported.row + 1}.${exported.col + 1} is ready. Click “Save STL file” below to finish downloading it.`);
    } catch {
      const row = Math.floor(index / COLS),
        col = index % COLS;
      setStatus(`Tile ${row + 1}.${col + 1} could not be created. Try fetching the terrain again.`);
    }
  }
  async function exportTileToFolder(index: number, folder: ProjectDirectoryHandle, boardIndex = activePuzzle) {
    const exported = tileExport(index, boardIndex, joinedElevations[boardIndex] ?? elevation),
      savedToFolder = await saveStlFile(exported.fileName, exported.data, folder);
    setStatus(
      savedToFolder
        ? `Tile ${exported.row + 1}.${exported.col + 1} saved to “${folder.name}”.`
        : "That folder could not be used. Choose it again and try the export once more.",
    );
  }
  function exportTile(index: number) {
    if (!browserCanChooseFolder()) {
      const row = Math.floor(index / COLS),
        col = index % COLS;
      setStatus(`Creating the high-resolution STL for tile ${row + 1}.${col + 1}…`);
      window.setTimeout(() => stageTileDownload(index), 30);
      return;
    }
    void exportTileToSelectedFolder(index);
  }
  async function exportTileToSelectedFolder(index: number) {
    const folder = await folderForStlExport();
    if (folder === undefined) return;
    if (!folder) {
      setStatus("The folder could not be opened. Try the export again and choose a folder.");
      return;
    }
    await exportTileToFolder(index, folder);
  }
  function boardExport(boardIndex = activePuzzle, boardElevation = elevation) {
    if (!board) {
      setStatus("Load board.stl first to export the complete terrain board.");
      return null;
    }
    const terrain = terrainBoardTriangles(
      boardElevation,
      board.bounds,
      effectiveRelief,
    );
    return {
      fileName: `${fileStem(puzzleName)}-puzzle-r${Math.floor(boardIndex / puzzleColumns) + 1}-c${(boardIndex % puzzleColumns) + 1}-board.stl`,
      data: binaryStl([...readTriangles(board.data), ...terrain]),
    };
  }
  function exportBoard() {
    if (!board) {
      setStatus("Load board.stl first to export the complete terrain board.");
      return;
    }
    if (!browserCanChooseFolder()) {
      setStatus("Creating the high-resolution terrain board STL…");
      window.setTimeout(() => {
        const exported = boardExport();
        if (!exported) return;
        try {
          stageDownload(exported.fileName, exported.data);
          setStatus("The combined terrain board is ready. Click “Save STL file” below to finish downloading it.");
        } catch {
          setStatus("The terrain board could not be created. Try fetching the terrain again.");
        }
      }, 30);
      return;
    }
    void exportBoardToSelectedFolder();
  }
  async function exportBoardToSelectedFolder() {
    const folder = await folderForStlExport();
    if (folder === undefined) return;
    if (!folder) {
      setStatus("The folder could not be opened. Try the export again and choose a folder.");
      return;
    }
    const exported = boardExport();
    if (!exported) return;
    const savedToFolder = await saveStlFile(exported.fileName, exported.data, folder);
    setStatus(
      savedToFolder
        ? `Combined terrain board saved to “${folder.name}”.`
        : "That folder could not be used. Choose it again and try the export once more.",
    );
  }
  function exportAll() {
    if (!browserCanChooseFolder()) {
      setStatus("This browser can save one STL at a time. Creating the selected tile now; use a browser with folder access for all 16 files at once.");
      window.setTimeout(() => stageTileDownload(selected), 30);
      return;
    }
    void exportAllToSelectedFolder();
  }
  async function exportAllToSelectedFolder() {
    const folder = await folderForStlExport();
    if (folder === undefined) return;
    if (!folder) {
      setStatus("The folder could not be opened. Try the export again and choose a folder.");
      return;
    }
    for (let i = 0; i < TILE_COUNT; i += 1) await exportTileToFolder(i, folder);
    setStatus(
      folder
        ? `All 16 STL files saved to “${folder.name}”.`
        : "All 16 STL files were downloaded. Your browser may ask to allow multiple files.",
    );
  }
  function exportAllJoined() {
    if (!browserCanChooseFolder()) {
      setStatus("This browser can save one STL at a time. Use a browser with folder access to save every joined puzzle board at once.");
      return;
    }
    void exportAllJoinedToSelectedFolder();
  }
  async function exportAllJoinedToSelectedFolder() {
    const folder = await folderForStlExport();
    if (folder === undefined) return;
    if (!folder) {
      setStatus("The folder could not be opened. Try the export again and choose a folder.");
      return;
    }
    for (let boardIndex = 0; boardIndex < joinedPuzzleCount; boardIndex += 1)
      for (let tileIndex = 0; tileIndex < TILE_COUNT; tileIndex += 1)
        await exportTileToFolder(tileIndex, folder, boardIndex);
    setStatus(`All ${joinedPuzzleCount * TILE_COUNT} joined-puzzle tile STLs saved to “${folder.name}”.`);
  }
  return (
    <main data-pages-build="20260823">
      <header>
        <div className="brand">
          <span className="mark">⌁</span>
          <div>
            <strong>Terrain Puzzle</strong>
            <small>4 × 4 printable map</small>
          </div>
        </div>
        <div className="headerNote">25 mm tiles · 110.25 mm terrain board</div>
      </header>
      <section className="workspace">
        <aside className="panel controls">
          <div className="step">
            <span>01</span>
            <div>
              <h2>Map & terrain</h2>
              <p>Search or open the map to choose your terrain square.</p>
            </div>
          </div>
          <div className="mapMount">
            <MapPicker
              latitude={Number(lat) || 30.85274}
              longitude={Number(lon) || 34.78200}
              areaKm={Math.max(0.1, Number(span) || 10)}
              puzzleRows={puzzleRows}
              puzzleColumns={puzzleColumns}
              onPick={(nextLat, nextLon) => {
                setLat(nextLat.toFixed(5));
                setLon(nextLon.toFixed(5));
                setStatus(
                  `Terrain square moved to ${nextLat.toFixed(5)}, ${nextLon.toFixed(5)}.`,
                );
              }}
            />
          </div>
          <div className="coordinates">
            <label>
              Latitude
              <input
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <label>
              Longitude
              <input
                value={lon}
                onChange={(e) => setLon(e.target.value)}
                inputMode="decimal"
              />
            </label>
          </div>
          <label>
            Board map width <output>{span} km</output>
            <input
              type="range"
              min=".1"
              max="200"
              step=".1"
              value={span}
              onChange={(e) => setSpan(e.target.value)}
            />
          </label>
          <div className="areaAdjust" aria-label="Adjust area width">
            <button type="button" onClick={() => adjustArea(-1)}>
              −1 km
            </button>
            <button type="button" onClick={() => adjustArea(1)}>
              +1 km
            </button>
            <button type="button" onClick={() => adjustArea(-0.1)}>
              −0.1 km
            </button>
            <button type="button" onClick={() => adjustArea(0.1)}>
              +0.1 km
            </button>
          </div>
          <label>
            Joined puzzle layout <output>{puzzleRows} × {puzzleColumns}</output>
            <select
              value={`${puzzleRows}x${puzzleColumns}`}
              onChange={(event) => {
                const [rows, columns] = event.target.value.split("x").map(Number);
                changeJoinedLayout(rows, columns);
              }}
            >
              <option value="1x1">1 × 1 — one puzzle</option>
              <option value="1x2">1 × 2 — side by side</option>
              <option value="2x1">2 × 1 — stacked</option>
              <option value="2x2">2 × 2 — four joined puzzles</option>
              <option value="1x3">1 × 3 — three across</option>
              <option value="3x1">3 × 1 — three tall</option>
              <option value="3x3">3 × 3 — nine joined puzzles</option>
            </select>
          </label>
          <label>
            Puzzle name
            <input
              value={puzzleName}
              onChange={(e) => setPuzzleName(e.target.value)}
              placeholder="terrain-puzzle"
            />
          </label>
          <button className="primary" onClick={fetchElevation}>
            Fetch & slice terrain <span>→</span>
          </button>
          <p className="hint">
            Terrain contains elevation only: no roads, trails, or buildings are
            added.
          </p>
        </aside>
        <section className="panel review">
          <div className="reviewHead">
            <div>
              <p className="eyebrow">TILE LAYOUT</p>
              <h2>Choose the marker tile · board {activePuzzleRow}.{activePuzzleColumn}</h2>
              <p>Each board has one fixed placeholder. Choose a board, then click a tile to move its placeholder.</p>
            </div>
            <div className="legend">
              <i></i> puzzle tile <b>צ</b> placeholder
            </div>
          </div>
          {joinedPuzzleCount > 1 && (
            <div
              className="joinedBoardPicker"
              style={{ gridTemplateColumns: `repeat(${puzzleColumns}, minmax(0, 1fr))` }}
              aria-label="Choose joined puzzle board"
            >
              {Array.from({ length: joinedPuzzleCount }, (_, index) => (
                <button
                  key={index}
                  type="button"
                  className={index === activePuzzle ? "active" : ""}
                  onClick={() => choosePuzzle(index)}
                >
                  Board {Math.floor(index / puzzleColumns) + 1}.{(index % puzzleColumns) + 1}
                  {placeholderIndices[index] !== undefined ? " · צ" : ""}
                </button>
              ))}
            </div>
          )}
          <div
            className="boardPreview"
            aria-label="Assembled board preview with 5 millimetre terrain rim"
          >
            <BoardRimPreview values={elevation} />
            <div className="tileOpening">
              <div className="tiles" aria-label="Terrain tile selection">
                {Array.from({ length: TILE_COUNT }, (_, i) => (
                  <TilePreview
                    key={i}
                    index={i}
                    selected={i === selected}
                    placeholder={placeholderIndices[activePuzzle] === i}
                    values={elevation}
                    onClick={() => setSelected(i)}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="status" role="status">
            <span></span>
            {status}
          </div>
        </section>
        <aside className="panel inspector">
          <p className="eyebrow">SELECTED TILE & EXPORT</p>
          <h2>
            Board {activePuzzleRow}.{activePuzzleColumn} · tile {selectedRow}.{selectedCol}
          </h2>
          <div className="tileDiagram">
            <div className="terrainShape"></div>
            <div className={`baseShape ${selectedPlaceholder ? "placeholderBase" : ""}`}></div>
          </div>
          <div className="choice">
            <b>
              {selectedPlaceholder
                ? "Placeholder + terrain"
                : "Puzzle base + terrain"}
            </b>
            <p>
              {selectedPlaceholder
                ? "Your 25 × 25 mm placeholder replaces this tile. The צ is trimmed to 1 mm above this tile's highest terrain."
                : "Terrain overlaps the template top by 0.25 mm for a slicer-ready combined STL."}
            </p>
            {selectedPlaceholder ? (
              <p className="printNote">This is the fixed placeholder position.</p>
            ) : (
              <button className="toggle placeholderToggle" onClick={movePlaceholder}>
                Move placeholder here
              </button>
            )}
          </div>
          <label>
            Terrain height modifier <output>×{verticalModifier}</output>
            <select
              value={verticalModifier}
              onChange={(e) => setVerticalModifier(e.target.value)}
            >
              <option value="0.25">×0.25 — very flat</option>
              <option value="0.5">×0.5 — flatter</option>
              <option value="1">×1 — true scale</option>
              <option value="1.5">×1.5 — enhanced</option>
              <option value="2">×2 — strong</option>
              <option value="2.5">×2.5 — very strong</option>
              <option value="3">×3 — maximum</option>
            </select>
          </label>
          <p className="printNote">
            ×1 is true vertical-to-horizontal scale: {trueScaleRelief.toFixed(2)}
            mm from the {Math.round(elevationRangeM)} m terrain range across a
            {terrainSpanKm * puzzleColumns} × {terrainSpanKm * puzzleRows} km joined map. Current output: {effectiveRelief.toFixed(2)} mm.
          </p>
          <button className="viewerButton" type="button" onClick={() => setViewerOpen(true)}>
            Open 3D terrain viewer
          </button>
          <div className="projectActions" aria-label="Project files">
            <button type="button" onClick={() => void saveProject()}>
              Save project to folder
            </button>
            <label className="projectLoad">
              <input
                type="file"
                accept=".json,.terrain-puzzle.json,application/json"
                onChange={loadProject}
              />
              Load saved project
            </label>
          </div>
          <p className="projectMemory">
            {projectFolderName
              ? `Saving to “${projectFolderName}”. This project will reopen after refresh.`
              : "Save once to choose a folder. Browsers without folder access download the file instead; your latest project still reopens after refresh."}
          </p>
          {readyProjectSave && (
            <a
              className="download readyDownload"
              href={readyProjectSave.url}
              download={readyProjectSave.name}
            >
              Save project file
            </a>
          )}
          <div className="exports">
            <button
              className="download"
              type="button"
              onClick={() => exportTile(selected)}
            >
              Download selected STL
            </button>
            <button className="download all" type="button" onClick={exportAll}>
              Download all 16 STLs for this board
            </button>
            {joinedPuzzleCount > 1 && (
              <button className="download all" type="button" onClick={exportAllJoined}>
                Download all {joinedPuzzleCount * TILE_COUNT} joined-puzzle STLs
              </button>
            )}
            <button
              className="download board"
              type="button"
              onClick={exportBoard}
              disabled={!board}
            >
              {board
                ? "Download combined terrain board"
                : "Load board STL to export board terrain"}
            </button>
          </div>
          {readyDownload && (
            <a
              className="download readyDownload"
              href={readyDownload.url}
              download={readyDownload.name}
            >
              Save STL file
            </a>
          )}
          <p className="printNote">
            The board export has a fixed 5 mm terrain rim. Its 100.25 × 100.25 mm
            opening leaves 0.125 mm clearance around the 100 × 100 mm tile
            surface, while the terrain height matches exactly at every tile edge.
          </p>
        </aside>
      </section>
      {viewerOpen && (
        <TerrainViewer
          values={elevation}
          relief={effectiveRelief}
          modifier={verticalModifier}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </main>
  );
}
