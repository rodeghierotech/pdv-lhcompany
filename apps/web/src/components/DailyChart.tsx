import { formatBRL } from '@pdv/shared';
import type { DailyPointDTO } from '@pdv/shared';
import { formatDateOnly } from '@/lib/utils';

/** Barras agrupadas por dia: faturamento (vendas feitas) × recebido líquido. SVG sem dependências. */
export function DailyChart({ items }: { items: DailyPointDTO[] }) {
  const W = 720;
  const H = 200;
  const pad = { l: 8, r: 8, t: 8, b: 22 };
  const max = Math.max(1, ...items.flatMap((i) => [i.grossCents, Math.max(i.receivedNetCents, 0)]));
  const slot = (W - pad.l - pad.r) / Math.max(items.length, 1);
  const bar = Math.min(slot * 0.38, 22);
  const h = (v: number) => ((H - pad.t - pad.b) * Math.max(v, 0)) / max;
  const every = Math.ceil(items.length / 10);
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Faturamento e recebimento por dia"
        className="h-52 w-full"
      >
        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={H - pad.b}
          y2={H - pad.b}
          stroke="currentColor"
          opacity="0.2"
        />
        {items.map((i, idx) => {
          const cx = pad.l + slot * idx + slot / 2;
          const base = H - pad.b;
          return (
            <g key={i.date}>
              <title>
                {`${formatDateOnly(i.date)} · vendas ${formatBRL(i.grossCents)} (${i.salesCount}) · recebido líquido ${formatBRL(i.receivedNetCents)}`}
              </title>
              <rect
                x={cx - bar - 1}
                y={base - h(i.grossCents)}
                width={bar}
                height={h(i.grossCents)}
                rx="2"
                className="fill-primary"
              />
              <rect
                x={cx + 1}
                y={base - h(i.receivedNetCents)}
                width={bar}
                height={h(i.receivedNetCents)}
                rx="2"
                className="fill-success"
              />
              {idx % every === 0 && (
                <text
                  x={cx}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize="10"
                  className="fill-muted-foreground"
                >
                  {formatDateOnly(i.date).slice(0, 5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary" /> Faturamento (vendas feitas)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-success" /> Recebido líquido
        </span>
      </figcaption>
    </figure>
  );
}
