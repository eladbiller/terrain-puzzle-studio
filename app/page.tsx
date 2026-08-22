"use client";

import {
  ChangeEvent,
  FormEvent,
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
  BASE_RELIEF_MM = 8;

type SavedProject = {
  version: 1;
  puzzleName: string;
  lat: string;
  lon: string;
  span: string;
  verticalModifier: string;
  selected: number;
  placeholderIndex: number | null;
  elevation: number[];
};

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
    startX = col * perTile,
    startY = row * perTile,
    // The puzzle connectors extend unevenly on two sides. Terrain belongs on
    // the centered 25 × 25 mm printable top, not the connector envelope.
    centerX = 0,
    centerY = 0,
    support =
      supportOverride ??
      (terrainOnly ? Math.max(bounds.minZ, 0) + 1.2 : bounds.maxZ - 0.25),
    floor = terrainOnly ? support - 1.2 : support - 0.18;
  const at = (x: number, y: number) =>
    values[(startY + y) * (GRID + 1) + startX + x];
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
  const perTile = GRID / COLS,
    startX = col * perTile,
    startY = row * perTile;
  let highest = 0;
  for (let y = 0; y <= perTile; y += 1)
    for (let x = 0; x <= perTile; x += 1)
      highest = Math.max(
        highest,
        values[(startY + y) * (GRID + 1) + startX + x],
      );
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
    support = bounds.maxZ - 0.35,
    floor = support - 0.25,
    rimX = BOARD_TERRAIN_RIM_MM / width,
    rimY = BOARD_TERRAIN_RIM_MM / depth;
  const point = (x: number, y: number, bottom = false) => [
    bounds.minX + (width * x) / GRID,
    bounds.minY + (depth * y) / GRID,
    bottom ? floor : support + values[y * (GRID + 1) + x] * relief,
  ];
  const tris: number[][] = [],
    add = (a: number[], b: number[], c: number[]) =>
      tris.push([...a, ...b, ...c]);
  const isRing = (x: number, y: number) => {
    const u = (x + 0.5) / GRID,
      v = (y + 0.5) / GRID;
    return u < rimX || u > 1 - rimX || v < rimY || v > 1 - rimY;
  };
  for (let y = 0; y < GRID; y += 1)
    for (let x = 0; x < GRID; x += 1) {
      if (!isRing(x, y)) continue;
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
      if (y === 0 || !isRing(x, y - 1)) {
        add(ab, b, bb);
        add(ab, a, b);
      }
      if (y === GRID - 1 || !isRing(x, y + 1)) {
        add(db, cb, c);
        add(db, c, d);
      }
      if (x === 0 || !isRing(x - 1, y)) {
        add(ab, db, d);
        add(ab, d, a);
      }
      if (x === GRID - 1 || !isRing(x + 1, y)) {
        add(bb, c, cb);
        add(bb, b, c);
      }
    }
  return tris;
}
function download(name: string, data: ArrayBuffer, type = "model/stl") {
  const url = URL.createObjectURL(new Blob([data], { type })),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  kilometres: number,
) {
  const latScale = 111.32,
    lonScale = 111.32 * Math.cos((latitude * Math.PI) / 180);
  return {
    minLat: latitude - kilometres / (2 * latScale),
    maxLat: latitude + kilometres / (2 * latScale),
    minLon: longitude - kilometres / (2 * lonScale),
    maxLon: longitude + kilometres / (2 * lonScale),
  };
}

async function elevationFromGeoTiff(
  buffer: ArrayBuffer,
  region: ReturnType<typeof terrainRegion>,
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
    width: GRID + 1,
    height: GRID + 1,
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
  onPick,
}: {
  latitude: number;
  longitude: number;
  areaKm: number;
  onPick: (latitude: number, longitude: number) => void;
}) {
  const [zoom, setZoom] = useState(12),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<
      { display_name: string; lat: string; lon: string }[]
    >([]),
    [searching, setSearching] = useState(false),
    [view, setView] = useState({ latitude, longitude });
  useEffect(() => {
    setView({ latitude, longitude });
  }, [latitude, longitude]);
  const x = tileX(view.longitude, zoom),
    y = tileY(view.latitude, zoom),
    selectedX = tileX(longitude, zoom),
    selectedY = tileY(latitude, zoom),
    world = 256 * 2 ** zoom;
  const tiles = useMemo(
    () =>
      Array.from({ length: 25 }, (_, i) => {
        const dx = (i % 5) - 2,
          dy = Math.floor(i / 5) - 2,
          tx = Math.floor(x) + dx,
          ty = Math.floor(y) + dy;
        return { id: `${zoom}-${tx}-${ty}`, tx, ty };
      }),
    [x, y, zoom],
  );
  const halfSide = Math.max(
    16,
    Math.min(
      110,
      (areaKm * world) /
        (40075 * Math.max(0.2, Math.cos((latitude * Math.PI) / 180))) /
        2,
    ),
  );
  const selectedLeft = (selectedX - x) * 256,
    selectedTop = (selectedY - y) * 256,
    metresPerPixel =
      (40075016.686 * Math.max(0.2, Math.cos((latitude * Math.PI) / 180))) /
      (256 * 2 ** zoom),
    stepKm = Math.max(0.01, (metresPerPixel * 16) / 1000);
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
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=il&q=${encodeURIComponent(query)}`,
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
  return (
    <div className="mapPicker">
      <form className="mapSearch" onSubmit={search}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a place in Israel"
          aria-label="Search a place in Israel"
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
      <div
        className="mapSurface"
        role="img"
        aria-label="Static map with the selected square."
      >
        {tiles.map((t) => (
          <img
            key={t.id}
            src={`https://tile.openstreetmap.org/${zoom}/${t.tx}/${t.ty}.png`}
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
            width: halfSide * 2,
            height: halfSide * 2,
            left: `calc(50% + ${selectedLeft}px)`,
            top: `calc(50% + ${selectedTop}px)`,
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
      </div>
      <div className="mapZoom">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(16, z + 1))}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(5, z - 1))}
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
        . The selected square remains centered.
      </p>
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
    const image = context.createImageData(size, size),
      perTile = GRID / COLS;
    const shade = (u: number, v: number) => {
      const gx = col * perTile + u * perTile,
        gy = row * perTile + v * perTile,
        x = Math.max(0, Math.min(GRID, Math.round(gx))),
        y = Math.max(0, Math.min(GRID, Math.round(gy))),
        h = values[y * (GRID + 1) + x] ?? 0,
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

export default function Home() {
  const [tile, setTile] = useState<Template | null>(null),
    [board, setBoard] = useState<Template | null>(null),
    [placeholder, setPlaceholder] = useState<Template | null>(null),
    [dem, setDem] = useState<{ name: string; data: ArrayBuffer } | null>(null),
    [elevation, setElevation] = useState(() => demoElevation()),
    [selected, setSelected] = useState(12),
    [placeholderIndex, setPlaceholderIndex] = useState<number | null>(null),
    [lat, setLat] = useState("30.81667"),
    [lon, setLon] = useState("34.76667"),
    [span, setSpan] = useState("2"),
    [verticalModifier, setVerticalModifier] = useState("1"),
    [puzzleName, setPuzzleName] = useState("terrain-puzzle"),
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
    selectedPlaceholder = placeholderIndex === selected,
    effectiveRelief = BASE_RELIEF_MM * Math.max(0.1, Number(verticalModifier) || 1),
    totals = useMemo(
      () => ({
        regular: TILE_COUNT - (placeholderIndex === null ? 0 : 1),
        placeholder: placeholderIndex === null ? 0 : 1,
      }),
      [placeholderIndex],
    );
  useEffect(() => {
    let cancelled = false;
    async function loadTemplates() {
      try {
        const [builtInTile, builtInBoard, builtInPlaceholder] = await Promise.all([
          loadBuiltInTemplate("/tile.stl", "Built-in puzzle tile"),
          loadBuiltInTemplate("/board.stl", "Built-in puzzle board"),
          loadBuiltInTemplate("/placeholder.stl", "Built-in placeholder tile"),
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
      kilometres = Math.max(0.1, Number(span));
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
      const region = terrainRegion(latitude, longitude, kilometres),
        { minLat, maxLat, minLon, maxLon } = region;
      let samples: number[];
      if (dem) samples = await elevationFromGeoTiff(dem.data, region);
      else {
        const zoom =
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
        const minX = tileX(minLon, zoom),
          maxX = tileX(maxLon, zoom),
          minY = tileY(maxLat, zoom),
          maxY = tileY(minLat, zoom);
        const keys: { x: number; y: number }[] = [];
        for (let y = Math.floor(minY) - 1; y <= Math.floor(maxY) + 1; y += 1)
          for (let x = Math.floor(minX) - 1; x <= Math.floor(maxX) + 1; x += 1)
            keys.push({ x, y });
        if (keys.length > 36)
          throw new Error("Choose a smaller area for the dense terrain mesh.");
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
        for (let row = 0; row <= GRID; row += 1)
          for (let col = 0; col <= GRID; col += 1) {
            const sampleLat = maxLat - ((maxLat - minLat) * row) / GRID,
              sampleLon = minLon + ((maxLon - minLon) * col) / GRID;
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
      const low = Math.min(...samples),
        high = Math.max(...samples),
        range = Math.max(1, high - low);
      setElevation(samples.map((value) => (value - low) / range));
      setStatus(
        `${dem ? dem.name : "Terrain"} loaded: ${Math.round(low)}–${Math.round(high)} m. Select any tile to change its base.`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Terrain could not be loaded.",
      );
    }
  }
  function togglePlaceholder() {
    if (!placeholder) {
      setStatus("The built-in placeholder tile is still loading.");
      return;
    }
    if (selectedPlaceholder) {
      setPlaceholderIndex(null);
      setStatus(`Placeholder removed from tile ${selectedRow}.${selectedCol}.`);
      return;
    }
    setPlaceholderIndex(selected);
    setStatus(
      `Tile ${selectedRow}.${selectedCol} is now the placeholder. Its צ stays 1 mm above this tile's highest terrain.`,
    );
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
  function saveProject() {
    const project: SavedProject = {
        version: 1,
        puzzleName,
        lat,
        lon,
        span,
        verticalModifier,
        selected,
        placeholderIndex,
        elevation,
      },
      bytes = new TextEncoder().encode(JSON.stringify(project));
    download(
      `${fileStem(puzzleName)}.terrain-puzzle.json`,
      bytes.buffer as ArrayBuffer,
      "application/json",
    );
    setStatus("Project saved. Load this project file later to continue here.");
  }
  async function loadProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const saved = JSON.parse(await file.text()) as Partial<SavedProject>;
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.elevation) ||
        saved.elevation.length !== (GRID + 1) ** 2 ||
        !saved.elevation.every((value) => Number.isFinite(value))
      )
        throw new Error("This is not a valid Terrain Puzzle project file.");
      setPuzzleName(typeof saved.puzzleName === "string" ? saved.puzzleName : "terrain-puzzle");
      setLat(typeof saved.lat === "string" ? saved.lat : "30.81667");
      setLon(typeof saved.lon === "string" ? saved.lon : "34.76667");
      setSpan(typeof saved.span === "string" ? saved.span : "2");
      setVerticalModifier(
        typeof saved.verticalModifier === "string" ? saved.verticalModifier : "1",
      );
      setSelected(
        Number.isInteger(saved.selected) &&
          (saved.selected as number) >= 0 &&
          (saved.selected as number) < TILE_COUNT
          ? (saved.selected as number)
          : 12,
      );
      setPlaceholderIndex(
        Number.isInteger(saved.placeholderIndex) &&
          (saved.placeholderIndex as number) >= 0 &&
          (saved.placeholderIndex as number) < TILE_COUNT
          ? (saved.placeholderIndex as number)
          : null,
      );
      setElevation(saved.elevation);
      setStatus(`Project “${file.name}” loaded. You can continue working.`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Project file could not be loaded.",
      );
    } finally {
      event.target.value = "";
    }
  }
  function exportTile(index: number) {
    const isPlaceholder = placeholderIndex === index && Boolean(placeholder),
      row = Math.floor(index / COLS),
      col = index % COLS,
      source = isPlaceholder ? placeholder : tile,
      sourceBounds = isPlaceholder && placeholder ? placeholder.bounds : tileBounds,
      support = isPlaceholder ? 0 : undefined,
      terrain = terrainTriangles(
        elevation,
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
              terrainPeak(elevation, row, col, effectiveRelief, 0),
            )
          : source
            ? readTriangles(source.data)
            : [],
      combined = !source ? terrain : [...sourceTriangles, ...terrain];
    download(
      `${fileStem(puzzleName)}-tile-r${row + 1}-c${col + 1}${isPlaceholder ? "-placeholder" : ""}.stl`,
      binaryStl(combined),
    );
    setStatus(`Tile ${row + 1}.${col + 1} downloaded.`);
  }
  function exportBoard() {
    if (!board) {
      setStatus("Load board.stl first to export the complete terrain board.");
      return;
    }
    const terrain = terrainBoardTriangles(
      elevation,
      board.bounds,
      effectiveRelief,
    );
    download(
      `${fileStem(puzzleName)}-board.stl`,
      binaryStl([...readTriangles(board.data), ...terrain]),
    );
    setStatus(
      "Combined terrain board downloaded. It includes the board STL and the continuous terrain surface in one file.",
    );
  }
  function exportAll() {
    for (let i = 0; i < TILE_COUNT; i += 1)
      window.setTimeout(() => exportTile(i), i * 180);
    setStatus(
      "Preparing the 16 STL downloads. Your browser may ask to allow multiple files.",
    );
  }
  return (
    <main>
      <header>
        <div className="brand">
          <span className="mark">⌁</span>
          <div>
            <strong>Terrain Puzzle</strong>
            <small>STL studio</small>
          </div>
        </div>
        <div className="headerNote">4 × 4 terrain assembly</div>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">FROM LANDSCAPE TO PRINTABLE PIECES</p>
          <h1>Build a terrain puzzle that fits your board.</h1>
          <p className="lede">
            Choose a landscape, review every cut piece, then export printable
            STL files that fit your fixed puzzle set.
          </p>
        </div>
        <div className="heroMetric">
          <b>{totals.regular}</b>
          <span>puzzle-base tiles</span>
          <b>{totals.placeholder}</b>
          <span>placeholder tile</span>
        </div>
      </section>
      <section className="workspace">
        <aside className="panel controls">
          <div className="step">
            <span>01</span>
            <div>
              <h2>Terrain area</h2>
              <p>Search for a place, then use arrows to move the square.</p>
            </div>
          </div>
          <div className="mapMount">
            <MapPicker
              latitude={Number(lat) || 30.81667}
              longitude={Number(lon) || 34.76667}
              areaKm={Number(span) || 2}
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
            Area width <output>{span} km</output>
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
              <p className="eyebrow">02 · REVIEW THE CUT</p>
              <h2>Choose a piece</h2>
              <p>Click a tile to decide whether it keeps the puzzle base.</p>
            </div>
            <div className="legend">
              <i></i> puzzle tile <b>צ</b> placeholder
            </div>
          </div>
          <div
            className="boardPreview"
            aria-label="Assembled board preview with 5 millimetre terrain rim"
          >
            <div className="boardRimPreview"></div>
            <div className="tiles" aria-label="Terrain tile selection">
              {Array.from({ length: TILE_COUNT }, (_, i) => (
                <TilePreview
                  key={i}
                  index={i}
                  selected={i === selected}
                  placeholder={placeholderIndex === i}
                  values={elevation}
                  onClick={() => setSelected(i)}
                />
              ))}
            </div>
          </div>
          <div className="status" role="status">
            <span></span>
            {status}
          </div>
        </section>
        <aside className="panel inspector">
          <p className="eyebrow">SELECTED TILE</p>
          <h2>
            Tile {selectedRow}.{selectedCol}
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
              <button className="toggle placeholderToggle" onClick={togglePlaceholder}>
                Remove placeholder
              </button>
            ) : (
              <button className="toggle placeholderToggle" onClick={togglePlaceholder}>
                {placeholderIndex === null
                  ? "Use placeholder for this tile"
                  : "Move placeholder here"}
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
              <option value="1">×1 — normal</option>
              <option value="1.5">×1.5 — enhanced</option>
              <option value="2">×2 — strong</option>
              <option value="2.5">×2.5 — very strong</option>
              <option value="3">×3 — maximum</option>
            </select>
          </label>
          <p className="printNote">
            Final printed height difference: {effectiveRelief.toFixed(1)} mm.
            Use a lower modifier for flatter terrain.
          </p>
          <div className="projectActions" aria-label="Project files">
            <button type="button" onClick={saveProject}>
              Save project to computer
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
          <div className="exports">
            <button className="download" onClick={() => exportTile(selected)}>
              Download selected STL
            </button>
            <button className="download all" onClick={exportAll}>
              Download all 16 STLs
            </button>
            <button
              className="download board"
              onClick={exportBoard}
              disabled={!board}
            >
              {board
                ? "Download combined terrain board"
                : "Load board STL to export board terrain"}
            </button>
          </div>
          <p className="printNote">
            The board export has a fixed 5 mm terrain rim. Its 100.2 × 100.2 mm
            opening leaves 0.1 mm clearance around the 100 × 100 mm tile
            surface.
          </p>
        </aside>
      </section>
    </main>
  );
}
