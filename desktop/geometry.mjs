// Capture coordinates are display-local CSS pixels, never global desktop pixels.
export function cropRect(selection, logical, physical) {
  const values = [
    selection.x,
    selection.y,
    selection.width,
    selection.height,
    logical.width,
    logical.height,
    physical.width,
    physical.height,
  ];
  if (
    !values.every(Number.isFinite) ||
    logical.width <= 0 ||
    logical.height <= 0 ||
    selection.width < 2 ||
    selection.height < 2
  )
    throw new Error("选区太小或无效");
  const left = Math.max(
    0,
    Math.min(
      physical.width - 1,
      Math.floor((selection.x * physical.width) / logical.width),
    ),
  );
  const top = Math.max(
    0,
    Math.min(
      physical.height - 1,
      Math.floor((selection.y * physical.height) / logical.height),
    ),
  );
  const right = Math.max(
    left + 1,
    Math.min(
      physical.width,
      Math.ceil(
        ((selection.x + selection.width) * physical.width) / logical.width,
      ),
    ),
  );
  const bottom = Math.max(
    top + 1,
    Math.min(
      physical.height,
      Math.ceil(
        ((selection.y + selection.height) * physical.height) / logical.height,
      ),
    ),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}
