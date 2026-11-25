// Larper's own pixel art, from the Larper OS design system. Decorative: whatever holds an icon
// carries the label.
type Pixels = { box: [number, number]; size: [number, number]; paths: [fill: string, d: string][] };

const ART = {
  logo: {
    box: [14, 12], size: [28, 24],
    paths: [
      ["#F9EFE4", "M2 0h2v1h-2zM2 1h1v1h-1zM4 1h7v1h-7zM2 2h1v1h-1zM10 2h2v1h-2zM2 3h1v1h-1zM11 3h2v1h-2zM2 4h1v1h-1zM10 4h2v1h-2zM2 5h1v1h-1zM4 5h7v1h-7zM2 6h2v1h-2zM2 7h2v1h-2zM2 8h2v1h-2zM2 9h2v1h-2zM2 10h2v1h-2zM1 11h4v1h-4z"],
      ["#E8756F", "M3 1h1v1h-1zM3 2h7v1h-7zM3 3h8v1h-8zM3 4h7v1h-7zM3 5h1v1h-1z"],
    ],
  },
  flag: {
    box: [14, 12], size: [32, 27],
    paths: [
      ["#000", "M2 0h2v1h-2zM2 1h1v1h-1zM4 1h7v1h-7zM2 2h1v1h-1zM10 2h2v1h-2zM2 3h1v1h-1zM11 3h2v1h-2zM2 4h1v1h-1zM10 4h2v1h-2zM2 5h1v1h-1zM4 5h7v1h-7zM2 6h2v1h-2zM2 7h2v1h-2zM2 8h2v1h-2zM2 9h2v1h-2zM2 10h2v1h-2zM1 11h4v1h-4z"],
      ["#E8756F", "M3 1h1v1h-1zM3 2h7v1h-7zM3 3h8v1h-8zM3 4h7v1h-7zM3 5h1v1h-1z"],
    ],
  },
  pigeon: {
    box: [20, 15], size: [56, 42],
    paths: [
      ["#3A3D55", "M6 0h3v1h-3zM5 1h1v1h-1zM9 1h1v1h-1zM4 2h1v1h-1zM9 2h1v1h-1zM4 3h1v1h-1zM8 3h1v1h-1zM5 4h1v1h-1zM9 4h1v1h-1zM5 5h1v1h-1zM10 5h2v1h-2zM5 6h1v1h-1zM13 6h1v1h-1zM4 7h1v1h-1zM15 7h1v1h-1zM4 8h1v1h-1zM16 8h2v1h-2zM4 9h1v1h-1zM17 9h3v1h-3zM5 10h1v1h-1zM16 10h1v1h-1zM6 11h2v1h-2zM14 11h2v1h-2zM8 12h2v1h-2zM12 12h2v1h-2z"],
      ["#9AA0B8", "M6 1h3v1h-3zM5 2h1v1h-1zM8 2h1v1h-1zM5 3h3v1h-3zM8 4h1v1h-1zM8 5h2v1h-2zM6 6h7v1h-7zM5 7h10v1h-10zM5 8h3v1h-3zM12 8h4v1h-4zM5 9h2v1h-2zM13 9h4v1h-4zM6 10h4v1h-4zM12 10h4v1h-4zM8 11h6v1h-6z"],
      ["#FFFDF8", "M6 2h1v1h-1z"],
      ["#000", "M7 2h1v1h-1z"],
      ["#E8A04C", "M2 3h2v1h-2zM8 13h1v1h-1zM13 13h1v1h-1zM7 14h2v1h-2zM12 14h2v1h-2z"],
      ["#79B8AE", "M6 4h2v1h-2zM6 5h2v1h-2z"],
      ["#D5D7E2", "M8 8h4v1h-4zM7 9h6v1h-6zM10 10h2v1h-2z"],
    ],
  },
} satisfies Record<string, Pixels>;

export function PixelArt({ name }: { name: keyof typeof ART }) {
  const { box, size, paths }: Pixels = ART[name];
  return (
    <svg viewBox={`0 0 ${box[0]} ${box[1]}`} width={size[0]} height={size[1]} shapeRendering="crispEdges" aria-hidden="true">
      {paths.map(([fill, d], i) => <path key={i} fill={fill} d={d} />)}
    </svg>
  );
}
