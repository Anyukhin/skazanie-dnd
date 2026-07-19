import type { MapCell } from './types'

type Feature = NonNullable<MapCell['feature']>

function PropDrawing({ feature }: { feature: Feature }) {
  switch (feature) {
    case 'bed': return <><rect className="prop-base" x="7" y="9" width="34" height="30" rx="4"/><rect className="prop-light" x="10" y="12" width="28" height="8" rx="3"/><path className="prop-detail" d="M10 23h28M18 23v13"/></>
    case 'table': return <><ellipse className="prop-shadow" cx="24" cy="27" rx="17" ry="11"/><ellipse className="prop-base" cx="24" cy="22" rx="17" ry="11"/><path className="prop-detail" d="M13 22h22M24 12v20"/></>
    case 'chair': return <><rect className="prop-base" x="13" y="15" width="22" height="22" rx="4"/><path className="prop-detail" d="M14 13h20M16 9h16M18 37v5M30 37v5"/></>
    case 'bookshelf': return <><rect className="prop-base" x="7" y="10" width="34" height="28" rx="2"/><path className="prop-detail" d="M10 18h28M10 27h28M14 11v7M20 19v8M28 11v7M34 28v9"/></>
    case 'fireplace': return <><path className="prop-base" d="M7 35V13h34v22h-7V22H14v13z"/><path className="prop-accent" d="M24 35c-8 0-10-6-7-12 2 4 5 2 6-5 8 6 12 17 1 17z"/><path className="prop-detail" d="M7 13h34M11 18h26"/></>
    case 'barrel': return <><ellipse className="prop-base" cx="24" cy="24" rx="14" ry="17"/><path className="prop-detail" d="M11 17h26M10 29h28M17 9c-3 10-3 20 0 30M31 9c3 10 3 20 0 30"/></>
    case 'crate': return <><rect className="prop-base" x="8" y="8" width="32" height="32" rx="2"/><path className="prop-detail" d="M11 11l26 26M37 11L11 37M8 16h32M8 32h32"/></>
    case 'tree': return <><ellipse className="prop-shadow" cx="25" cy="31" rx="18" ry="11"/><circle className="prop-base" cx="18" cy="22" r="12"/><circle className="prop-base" cx="29" cy="17" r="13"/><circle className="prop-light" cx="31" cy="27" r="11"/><circle className="prop-detail-fill" cx="24" cy="24" r="5"/></>
    case 'bush': return <><circle className="prop-base" cx="16" cy="25" r="10"/><circle className="prop-base" cx="25" cy="18" r="12"/><circle className="prop-light" cx="33" cy="27" r="10"/><circle className="prop-light" cx="22" cy="31" r="9"/></>
    case 'rock': return <><path className="prop-shadow" d="M7 35l5-19 13-9 14 10 3 17-10 7H16z"/><path className="prop-base" d="M7 31l5-19 13-7 14 10 3 15-10 7H16z"/><path className="prop-detail" d="M12 12l12 10 15-7M24 22l8 15"/></>
    case 'mushroom': return <><path className="prop-light" d="M7 24c1-11 8-17 17-17s16 6 17 17z"/><path className="prop-base" d="M20 23h9l4 17H16z"/><circle className="prop-detail-fill" cx="16" cy="16" r="2"/><circle className="prop-detail-fill" cx="29" cy="13" r="2"/><circle className="prop-detail-fill" cx="35" cy="19" r="1.7"/></>
    case 'bones': return <><path className="prop-detail" d="M10 11l28 26M38 11L10 37"/><circle className="prop-light" cx="9" cy="10" r="4"/><circle className="prop-light" cx="39" cy="38" r="4"/><circle className="prop-light" cx="39" cy="10" r="4"/><circle className="prop-light" cx="9" cy="38" r="4"/></>
    case 'grave': return <><path className="prop-shadow" d="M10 40V19C10 5 38 5 38 19v21z"/><path className="prop-base" d="M12 37V18c0-11 24-11 24 0v19z"/><path className="prop-detail" d="M24 15v15M18 21h12"/></>
    case 'pillar': return <><circle className="prop-shadow" cx="24" cy="27" r="18"/><circle className="prop-base" cx="24" cy="23" r="17"/><circle className="prop-light" cx="24" cy="23" r="11"/><circle className="prop-detail" cx="24" cy="23" r="6"/></>
    case 'statue': return <><rect className="prop-base" x="10" y="31" width="28" height="9" rx="2"/><circle className="prop-light" cx="24" cy="11" r="6"/><path className="prop-base" d="M17 31l3-16h8l4 16z"/><path className="prop-detail" d="M16 20l-5 8M32 20l5 8"/></>
    case 'campfire': return <><path className="prop-detail" d="M10 34l28-12M10 22l28 12"/><path className="prop-accent" d="M24 33c-10 0-13-8-8-17 2 5 6 4 8-7 10 9 13 24 0 24z"/><path className="prop-light" d="M24 31c-5 0-6-4-3-9 1 3 3 2 4-3 4 5 5 12-1 12z"/></>
    case 'wagon': return <><rect className="prop-base" x="7" y="12" width="29" height="24" rx="4"/><path className="prop-detail" d="M13 12v24M22 12v24M31 12v24M36 20l9-7"/><circle className="prop-shadow" cx="12" cy="38" r="6"/><circle className="prop-shadow" cx="32" cy="38" r="6"/></>
    case 'well': return <><ellipse className="prop-shadow" cx="24" cy="28" rx="19" ry="14"/><ellipse className="prop-base" cx="24" cy="23" rx="19" ry="14"/><ellipse className="prop-water" cx="24" cy="23" rx="12" ry="8"/><path className="prop-detail" d="M9 16l8 6M39 16l-8 6M7 27l10-5M41 27l-10-5"/></>
    case 'console': return <><path className="prop-base" d="M6 13h36l-4 27H10z"/><rect className="prop-water" x="11" y="17" width="26" height="11" rx="2"/><path className="prop-detail" d="M13 33h5M21 33h5M29 33h5"/></>
    case 'chest': return <><path className="prop-base" d="M7 19c0-8 34-8 34 0v20H7z"/><path className="prop-detail" d="M7 22h34M15 14v25M33 14v25"/><rect className="prop-accent" x="21" y="22" width="6" height="10" rx="2"/></>
    case 'altar': return <><path className="prop-shadow" d="M8 38l5-25h22l5 25z"/><path className="prop-base" d="M11 34l4-22h18l4 22z"/><path className="prop-accent" d="M24 16l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></>
    case 'torch': return <><path className="prop-detail" d="M24 23v19"/><path className="prop-accent" d="M24 27c-8 0-10-8-5-15 1 5 4 3 6-6 8 7 10 21-1 21z"/></>
    case 'rune': return <><circle className="prop-rune" cx="24" cy="24" r="17"/><path className="prop-rune" d="M24 8l6 11 11 5-11 6-6 10-6-10-11-6 11-5z"/></>
    case 'stairs': return <><path className="prop-base" d="M7 38h8v-7h7v-7h7v-7h7v-7h6v28z"/><path className="prop-detail" d="M8 38h34M15 31h27M22 24h20M29 17h13"/></>
    default: return <circle className="prop-base" cx="24" cy="24" r="13"/>
  }
}

export function MapProp({ feature }: { feature: Feature }) {
  return <svg className="map-prop" data-prop={feature} viewBox="0 0 48 48" aria-hidden="true" focusable="false"><PropDrawing feature={feature}/></svg>
}
