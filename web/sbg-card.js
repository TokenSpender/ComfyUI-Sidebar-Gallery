import { h, fmtBytes, timeAgo } from "./sbg-core.js";
import { AUDIO_ICON, PLAY_ICON } from "./sbg-icons.js";
import { isAudio, isVideo } from "./sbg-media-kind.js";
import { getSectionRenames } from "./sbg-translation-layer.js";
import { schemaBadgeLabels, schemaSections } from "./sbg-schema.js";

// A field can be a workflow node's name, whose spaces would split the class.
function _badgeModifier(field) {
  return String(field).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

const _BADGE_FALLBACK = { pos_prompt: "POSITIVE", neg_prompt: "NEGATIVE" };

/** What a match badge's name is read through, taken once for a whole draw. */
export function badgeLookups() {
  return { renames: getSectionRenames(), titles: schemaBadgeLabels(), sections: schemaSections() };
}

/** The name the section a search field belongs to shows, renamed as the person
 *  renamed it, or null where the search schema names no section for it. */
function badgeFieldName(field, { renames, titles, sections }) {
  const title = titles[String(field).toLowerCase()];
  return title ? (renames[title] || sections[title]?.display_name || title) : null;
}

/** A card's badge for a search that matched `field`, `count` times. The grid
 *  and the Theme tab's sample both draw theirs here. */
export function matchBadge(field, count, lookups) {
  const name = badgeFieldName(field, lookups);
  const label = name ? name.toUpperCase() : (_BADGE_FALLBACK[field] || field.toUpperCase());
  const text = count > 1 ? `${label}(${count})` : label;
  return h("span", { class: `sbg-card__match-badge sbg-card__match-badge--${_badgeModifier(field)}`, text, title: text });
}

// Height of the text below the picture per style, without match badges and then
// with two rows of them. The grid sizes its rows from these before any card exists.
export const CARD_INFO_HEIGHTS = Object.freeze({
  boxed: [42, 78],
  "one-line": [22, 60],
  picture: [0, 0],
});

const _ext = (it) => it.ext.replace(".", "").toUpperCase();

// Two badges and a count fit the two rows the badge strip holds.
const MAX_CARD_BADGES = 2;
// Below this card width the second badge and the count cannot share a row.
export const NARROW_CARD_PX = 60;

function badgeRow(matchBadges) {
  const shown = matchBadges.slice(0, MAX_CARD_BADGES);
  const rest = matchBadges.slice(MAX_CARD_BADGES);
  if (rest.length) {
    shown.push(h("span", {
      class: "sbg-card__match-badge sbg-card__badges-count",
      text: `+${rest.length}`,
      title: rest.map((b) => b.textContent).join(", "),
    }));
    // Shown instead of the second badge and the count above on a narrow card,
    // so it counts the second badge in with the rest.
    shown.push(h("span", {
      class: "sbg-card__match-badge sbg-card__badges-count sbg-card__badges-count--narrow",
      text: `+${rest.length + 1}`,
      title: matchBadges.slice(1).map((b) => b.textContent).join(", "),
    }));
  }
  return h("div", { class: "sbg-card__badges" + (rest.length ? " sbg-card__badges--counted" : "") }, shown);
}

// The grid and the Theme tab's sample both build cards here, so they cannot
// drift apart.
export function assembleCard(style, it, thumbWrap, favBtn, matchBadges = []) {
  const av = isVideo(it) || isAudio(it);
  const avIcon = isVideo(it) ? PLAY_ICON : AUDIO_ICON;
  const metaLine = () => h("div", { class: "sbg-card__meta", text: `${fmtBytes(it.size)} · ${timeAgo(it.mtime)}` });
  const typeBadge = () => h("span", { class: "sbg-card__kind sbg-card__kind--ext", html: avIcon + _ext(it) });
  const children = [thumbWrap];
  if (style === "one-line") {
    if (av) thumbWrap.appendChild(h("span", { class: "sbg-card__kind", html: avIcon }));
    thumbWrap.appendChild(favBtn);
    const info = h("div", { class: "sbg-card__info" }, [
      h("div", { class: "sbg-card__line" }, [
        h("div", { class: "sbg-card__name", text: it.filename }),
        // Past a week `timeAgo` gives a full date, too wide for the one line.
        h("span", { class: "sbg-card__age", text: timeAgo(it.mtime, { month: "short", day: "numeric" }) }),
      ]),
    ]);
    if (matchBadges.length) info.appendChild(badgeRow(matchBadges));
    children.push(info);
  } else if (style === "picture") {
    if (av) thumbWrap.appendChild(typeBadge());
    thumbWrap.appendChild(favBtn);
    thumbWrap.appendChild(h("div", { class: "sbg-card__overlay" }, [
      h("div", { class: "sbg-card__name", text: it.filename }),
      metaLine(),
    ]));
    if (matchBadges.length) thumbWrap.appendChild(badgeRow(matchBadges));
  } else {
    if (av) thumbWrap.appendChild(typeBadge());
    thumbWrap.appendChild(favBtn);
    children.push(h("div", { class: "sbg-card__info" }, [
      h("div", { class: "sbg-card__name", text: it.filename }),
      metaLine(),
      ...(matchBadges.length ? [badgeRow(matchBadges)] : []),
    ]));
  }
  return h("div", { class: `sbg-card sbg-card--${style}` }, children);
}
