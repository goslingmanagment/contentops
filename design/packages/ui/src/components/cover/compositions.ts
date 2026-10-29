import type { ComponentType } from 'react'
import type { CoverFamily } from './families'
import type { MotifProps } from './motif-props'
import { Bathtub, Bubbles, ShowerRain, Tiles } from './motifs/bath'
import { Bed, FloorLamp } from './motifs/bedroom'
import { Curtain, MirrorArch, NightWindow, WindowLight } from './motifs/interior'
import { KitchenWindow, Mug, TableTop } from './motifs/kitchen'
import { Drape, LaceBand, LaceMedallion } from './motifs/lace'
import { Bokeh, Sparkles, StringLights } from './motifs/light'
import { BlindStripes, Blinds, Desk, GridWindow } from './motifs/office'
import { Balloons, Cake, Candles, Confetti } from './motifs/party'
import { AppleTree, Hills, Leaves, Sun } from './motifs/street'

/** Слои сцены снизу вверх; имя слоя служит ключом при отрисовке. */
type Composition = Readonly<Record<string, ComponentType<MotifProps>>>

/**
 * Мотивы семейства (§7.9) в нескольких раскладках. У семейств, которые одни держат целый
 * раздел (вечер — FYP, кружево — сеты), раскладок больше: сотни плиток не сливаются.
 */
export const compositionsByFamily: Record<CoverFamily, readonly [Composition, ...Composition[]]> = {
  bedroom: [
    { windowLight: WindowLight, bed: Bed },
    { curtain: Curtain, floorLamp: FloorLamp, bed: Bed },
    { curtain: Curtain, floorLamp: FloorLamp },
  ],
  lace: [
    { drape: Drape, laceBand: LaceBand },
    { mirrorArch: MirrorArch, laceBand: LaceBand },
    { drape: Drape, laceMedallion: LaceMedallion },
    { curtain: Curtain, laceMedallion: LaceMedallion },
    { windowLight: WindowLight, laceBand: LaceBand },
    { bokeh: Bokeh, drape: Drape },
  ],
  party: [
    { confetti: Confetti, balloons: Balloons },
    { bokeh: Bokeh, cake: Cake, confetti: Confetti },
    { bokeh: Bokeh, candles: Candles },
  ],
  evening: [
    { bokeh: Bokeh, mirrorArch: MirrorArch, stringLights: StringLights },
    { bokeh: Bokeh, sparkles: Sparkles },
    { nightWindow: NightWindow, stringLights: StringLights },
    { curtain: Curtain, mirrorArch: MirrorArch, sparkles: Sparkles },
    { nightWindow: NightWindow, bokeh: Bokeh },
    { drape: Drape, stringLights: StringLights },
  ],
  bath: [
    { tiles: Tiles, bathtub: Bathtub, bubbles: Bubbles },
    { tiles: Tiles, bubbles: Bubbles },
    { tiles: Tiles, showerRain: ShowerRain },
    { windowLight: WindowLight, tiles: Tiles, bubbles: Bubbles },
  ],
  kitchen: [
    { kitchenWindow: KitchenWindow, mug: Mug },
    { tableTop: TableTop },
    { windowLight: WindowLight, mug: Mug },
  ],
  street: [
    { sun: Sun, hills: Hills },
    { sun: Sun, leaves: Leaves },
    { appleTree: AppleTree, leaves: Leaves },
  ],
  office: [
    { blinds: Blinds, desk: Desk },
    { blindStripes: BlindStripes, desk: Desk },
    { gridWindow: GridWindow, desk: Desk },
  ],
}
