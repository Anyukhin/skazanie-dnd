const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => v.map(n => n / Math.hypot(...v));
/** Геометрия для картинки; значения бросков сюда приходят только с сервера. */
export function dieMesh(sides) {
    let vertices = [];
    let faces = [];
    if (sides === 6) {
        vertices = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
        faces = [[4, 5, 6, 7], [1, 0, 3, 2], [0, 4, 7, 3], [5, 1, 2, 6], [3, 7, 6, 2], [0, 1, 5, 4]];
    }
    else if (sides === 10 || sides === 100) {
        const height = .11803398875;
        vertices = [[0, 1.11803398875, 0], [0, -1.11803398875, 0]];
        for (let i = 0; i < 10; i++)
            vertices.push([Math.cos(i * Math.PI / 5), i % 2 ? -height : height, Math.sin(i * Math.PI / 5)]);
        for (let i = 0; i < 10; i++)
            faces.push([i % 2, i + 2, (i + 1) % 10 + 2, (i + 2) % 10 + 2]);
    }
    else {
        if (sides === 4)
            vertices = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]];
        else {
            const p = (1 + Math.sqrt(5)) / 2;
            for (const a of [-1, 1])
                for (const b of [-p, p])
                    vertices.push([0, a, b], [a, b, 0], [b, 0, a]);
        }
        // У тетраэдра и икосаэдра все грани — тройки ближайших вершин.
        const edge = Math.min(...vertices.flatMap((a, i) => vertices.slice(i + 1).map(b => Math.hypot(...sub(a, b)))));
        const adjacent = (a, b) => Math.abs(Math.hypot(...sub(vertices[a], vertices[b])) - edge) < .001;
        for (let a = 0; a < vertices.length; a++)
            for (let b = a + 1; b < vertices.length; b++)
                for (let c = b + 1; c < vertices.length; c++) {
                    if (adjacent(a, b) && adjacent(b, c) && adjacent(c, a))
                        faces.push([a, b, c]);
                }
    }
    const radius = Math.max(...vertices.map(v => Math.hypot(...v)));
    vertices = vertices.map(v => v.map(n => n / radius));
    faces = faces.map(face => {
        const [a, b, c] = face.map(i => vertices[i]);
        return dot(cross(sub(b, a), sub(c, a)), a) < 0 ? [...face].reverse() : face;
    });
    const [a, b, c] = faces[0].map(i => vertices[i]);
    const z = unit(cross(sub(b, a), sub(c, a)));
    const x = unit(sub(b, a));
    const y = cross(z, x);
    return { vertices: vertices.map(v => [dot(v, x), dot(v, y), dot(v, z)]), faces };
}
export function drawDie(ctx, mesh, angle, value, sides, cx, size, tens = false) {
    const rotate = ([x, y, z]) => {
        const a = angle * 2, b = angle * 3, c = angle;
        const y1 = y * Math.cos(a) - z * Math.sin(a), z1 = y * Math.sin(a) + z * Math.cos(a);
        const x1 = x * Math.cos(b) + z1 * Math.sin(b), z2 = -x * Math.sin(b) + z1 * Math.cos(b);
        return [x1 * Math.cos(c) - y1 * Math.sin(c), x1 * Math.sin(c) + y1 * Math.cos(c), z2];
    };
    const vertices = mesh.vertices.map(rotate);
    const project = ([x, y, z]) => [cx + x * size * 4 / (4 - z), 200 - y * size * 4 / (4 - z)];
    const faces = mesh.faces.map((indices, index) => {
        const points = indices.map(i => vertices[i]);
        const normal = unit(cross(sub(points[1], points[0]), sub(points[2], points[0])));
        return { points, normal, index, depth: points.reduce((s, v) => s + v[2], 0) / points.length };
    }).sort((a, b) => a.depth - b.depth);
    for (const { points, normal, index } of faces) {
        if (normal[2] < .05)
            continue;
        const projected = points.map(project);
        const light = Math.max(0, dot(normal, unit([-.5, .8, 1])));
        ctx.beginPath();
        projected.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
        ctx.closePath();
        const fill = ctx.createLinearGradient(cx - size, 80, cx + size, 300);
        fill.addColorStop(0, `hsl(192 24% ${18 + light * 22}%)`);
        fill.addColorStop(1, `hsl(204 30% ${7 + light * 14}%)`);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = `rgba(231,194,128,${.4 + light * .6})`;
        ctx.lineWidth = 1.6;
        ctx.lineJoin = 'round';
        ctx.stroke();
        const center = points.reduce((sum, v) => sum.map((n, i) => n + v[i] / points.length), [0, 0, 0]);
        const [px, py] = project(center);
        const right = unit(sub(points[1], points[0]));
        const up = cross(normal, right);
        const [rx, ry] = project(center.map((n, i) => n + right[i] * .1));
        const [ux, uy] = project(center.map((n, i) => n + up[i] * .1));
        const number = value === null ? index + 1 : ((value - 1 + index) % (sides === 100 ? 10 : sides)) + 1;
        const label = sides === 100 ? (tens ? String((number % 10) * 10).padStart(2, '0') : String(number % 10)) : String(number);
        ctx.save();
        ctx.transform((rx - px) / (size * .1), (ry - py) / (size * .1), (px - ux) / (size * .1), (py - uy) / (size * .1), px, py);
        ctx.font = `600 ${size * (sides === 6 ? .55 : .36)}px Spectral, Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f5dfae';
        ctx.shadowColor = '#060b10';
        ctx.shadowBlur = 4;
        ctx.fillText(label, 0, 1);
        ctx.restore();
    }
}
