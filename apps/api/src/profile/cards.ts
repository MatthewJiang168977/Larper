// Onboarding "vibe" cards. Each one bundles a few taxonomy tags (names must
// exist in workers/internal/taxonomy/taxonomy.yaml; TagsService checks on boot).
export interface VibeCard {
  id: string;
  title: string;
  blurb: string;
  tags: string[];
}

export const VIBE_CARDS: VibeCard[] = [
  { id: 'matcha', title: 'Matcha, hojicha, anything green', blurb: 'A tea bar where they whisk it in front of you.', tags: ['matcha', 'hojicha', 'tea-house'] },
  { id: 'boba', title: 'A boba run', blurb: 'Brown sugar, thai tea, mochi on the side.', tags: ['bubble-tea', 'thai-tea', 'mochi'] },
  { id: 'line-dessert', title: 'Dessert worth a line', blurb: 'Ube soft serve, bingsu, black sesame everything.', tags: ['soft-serve', 'shaved-ice', 'ube', 'black-sesame', 'dessert'] },
  { id: 'noodle-counter', title: 'Noodles at a counter', blurb: 'Hand-pulled, ten seats, steamed-up window.', tags: ['hand-pulled-noodles', 'noodles', 'ramen', 'dumplings', 'chinese-regional'] },
  { id: 'counter-seat', title: 'Omakase or izakaya', blurb: 'Sit at the bar and let them decide.', tags: ['omakase-counter', 'izakaya', 'sushi', 'sake'] },
  { id: 'hidden-bar', title: 'The bar with no sign', blurb: 'Down the stairs, through the phone booth.', tags: ['speakeasy', 'cocktail-bar', 'underground', 'listening-bar'] },
  { id: 'dive', title: 'A proper dive', blurb: 'Jukebox, pool table, cash only.', tags: ['dive-bar', 'pub', 'billiards'] },
  { id: 'natty-wine', title: 'Natural wine, small plates', blurb: 'A chalkboard menu and a cloudy orange.', tags: ['natural-wine', 'wine-bar', 'european'] },
  { id: 'photobooth', title: 'Photobooth strips', blurb: 'Four frames, one bad blink.', tags: ['photobooth', 'karaoke', 'arcade'] },
  { id: 'games', title: 'Play something', blurb: 'Arcade cabinets, bowling, mini golf, board games.', tags: ['arcade', 'bowling', 'mini-golf', 'board-games', 'escape-room'] },
  { id: 'crate-digging', title: 'Crate digging', blurb: 'Records, used books, comics, zines.', tags: ['vinyl', 'used-books', 'comics', 'zines'] },
  { id: 'thrift', title: 'Thrift and vintage', blurb: 'The rack nobody else checked.', tags: ['thrift', 'antiques', 'flea-market'] },
  { id: 'paper', title: 'Pens, paper, art supplies', blurb: 'Stationery shops and hobby stores.', tags: ['stationery', 'art-supply', 'hobby-shop'] },
  { id: 'odd-museum', title: 'A small, odd museum', blurb: 'Tiny galleries, oddities, murals.', tags: ['gallery', 'museum', 'spooky', 'public-art'] },
  { id: 'live-set', title: 'A live set', blurb: 'Jazz club, piano bar, open mic comedy.', tags: ['jazz', 'live-music', 'piano-bar', 'comedy'] },
  { id: 'green', title: 'Somewhere green', blurb: 'Botanical gardens, piers, a quiet trail.', tags: ['botanical', 'park', 'waterfront', 'trail'] },
  { id: 'bathhouse', title: 'Bathhouse reset', blurb: 'Banya, sauna, cold plunge.', tags: ['bathhouse', 'meditation'] },
  { id: 'late-night', title: 'Late-night eats', blurb: '24-hour diners, carts, a 2am slice.', tags: ['diner', 'late-night', 'street-food', 'halal', 'pizza-slice'] },
];
