/**
 * Words for generated room passwords (design section 10.1).
 *
 * The suggestion is three of these joined by hyphens, such as
 * `owlbear-druid-wand`, so a DM can read it out at the table and a player can
 * type it on a phone. That shapes the list:
 *
 * - Short (3 to 8 letters), lowercase a to z only, and spelled the way they
 *   sound. Words with a common second spelling (griffon, donut) and
 *   homophone pairs that both fit a fantasy table (night and knight) were
 *   left out, so a password read aloud is typed right the first time.
 * - Family friendly: nothing crude, no slang with a second meaning, no gore.
 * - About 1,600 words, so three of them give about 32 bits, which the join
 *   rate limits in section 10.3 put far out of reach of guessing.
 *
 * Fantasy names (owlbear, druid, wand and similar) come from the System
 * Reference Document 5.2.1, the rest are common English nouns.
 *
 * This work includes material from the System Reference Document 5.2.1
 * ("SRD 5.2.1") by Wizards of the Coast LLC, available at
 * https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative
 * Commons Attribution 4.0 International License, available at
 * https://creativecommons.org/licenses/by/4.0/legalcode.
 */
export const WORDS: readonly string[] = Object.freeze(
  `
  abacus abbey abbot acorn acrobat adder admiral agate aid air alarm alcove alder alley almanac
  almond alpaca amber amethyst amulet anchor angel angle ant anteater antelope anthem antler anvil
  ape apple apricot apron aqueduct arbor arcade arch archer archway arena aria armada armchair
  armor arrow artist ash aspen aster asteroid atlas attic augury aurora author autumn avenue axe
  axle azure backpack badge badger bagel bagpipe baker bakery balcony ball ballad balloon bamboo
  banana bandana bandit bane bangle banjo banner banquet bard barge bark barkskin barley barn
  baron barrel basil basilisk basin basket bass bastion bat bauble bay bazaar beach beacon bean
  beanie bear bed bedpost bedroll bedroom bee beehive beet beetle belfry bell bellhop bellows belt
  bench berry beryl bicycle bindle birch biscuit bishop bison blade blanket blaze bless blimp
  blink blizzard block bloom blossom bluebell bluebird bluff boar boat bobbin bobcat bog bolero
  bolt bonfire bonnet book boots bottle boulder bouquet bow bowl box bracelet bracers bramble
  branch brass brazier bread breeze brewer brick bridge bridle brigand brine bristle bronze brooch
  brook broom brush bubble buck bucket buckle buckler bud buffalo bugbear buggy bugle bulwark
  bundle bungalow burlap burrow bus butler butter button buttress buzz cabbage cabin cabinet cable
  caboose cactus caddy cadence cairn cake calf calico camel camellia camera campfire canal candle
  candy canoe canopy canteen canticle canvas canyon cap captain caramel caravan cardinal caribou
  carol carp carpet carriage carrot cart carton carving cascade cashew castle cat catapult
  cauldron causeway cave cavern cedar celery cellar cello centaur chain chair chalet chalice chalk
  chamber champion chant chapel chariot charm charter checker cheer cheese cheetah chef cherry
  chess chest chestnut chick chime chimera chimney chipmunk chisel chorus cider cinder cinnamon
  circle circlet cistern citadel citrus city clam clasp clay cleric cliff cloak clock cloister
  closet cloud clove clover clue coach coast coat cobalt cobble cobbler cobweb cocoa coconut
  cocoon cod codex coffer coin colt comb comet command compass concert conch condor cone conjure
  cook cookie cooper copper coral cork corn cornet corral cosmos cottage county cove cow cowbell
  coyote crab cradle crag crane crank crate crater crayon cream creek crest cricket crimson
  crochet crocus cross crossing crow crowbar crown crumpet crypt crystal cub cuckoo cup cupboard
  cupcake curio current curtain curve cushion cutlass cyclone cyclops cylinder cymbal cypress
  daffodil dahlia dainty daisy dam damsel dancer dark darkness darling dart date dawn daylight
  deer delta den desert dewdrop diadem dial diamond diary digger dill dimple dinghy dingo dispel
  dock doe doll dolphin domino donkey door doorway dormouse dot doublet dove dowel dragnet dragon
  drake drawer dream drill drizzle droplet druid drum dryad duchy duck duckling duet duke dumpling
  dune dungeon dusk dust dwarf eagle earl earring earth easel east echo eclair eclipse eel egg
  eggshell elbow elder elephant elf elixir elk elm ember embers emblem emerald empire emu enclave
  encore engine enlarge entangle envelope epic equinox eraser estuary ettin etude fable fairy
  falcon familiar fancy fanfare farm farmer fathom fawn feather fen fence fennel fern ferret ferry
  ferryman fiddle fiesta fig fighter figment filly finch fir fire fireball firefly fishbone fisher
  fjord flag flagon flail flame flamingo flapjack flash flask fleece flicker flint flotilla flower
  flurry flute fly foal foam fodder fog folio footpath forest forge fork fort fortune fossil
  fountain fox foxglove foxhole fresco friar frigate fritter frog frolic frost fudge fugue furnace
  gadget galaxy gale galleon gallery galley gallop game garden gargoyle garlic garnet gate gauge
  gauntlet gazebo gazelle gear gecko gem geode geyser gherkin giant giggle ginger giraffe glacier
  glade glaive gleam glee glider glimmer gloom glove glow gnoll gnome goat goblet goblin gold
  goldfish golem goliath gondola gong goose gopher gorge gorgon gorilla gosling gourd gown granary
  granite grape grapple gravel grease griddle grotto grouse grove guard guava guidance guitar gull
  gumdrop guppy gust haddock haiku hail halberd halfling hallway halo hamlet hammer hammock
  hamster handbell harbor hare harness harp harpy harvest haste hat hatchet haven hawk hawthorn
  haystack hazel headband healer heart hearth heath heather hedge hedgehog helm hemlock hen herald
  herb hermit hero heroine heroism heron hexagon hickory highland hill hilltop hinge hint hippo
  hitch hive hollow holly honey honeybee hood hook hoop horizon horn hornet horse hostel hotcake
  hubcap hull hum human hunter hurdle husk hyacinth hydra hyena ibex ice iceberg icicle identify
  idol igloo iguana imp impala indigo ink inkwell inlet inn iris iron island isle ivory ivy jackal
  jackdaw jacket jade jaguar jam jar jasmine jasper javelin jay jelly jester jetty jig jigsaw
  jingle jonquil journal journey joy jubilee jug juggler jump jungle juniper kale kangaroo kayak
  keel keep kernel kestrel kettle key keystone kiln kilt king kingdom kipper kitchen kite kitten
  kiwi knapsack knight knock knoll knot koala kobold kraken lace ladder ladle ladybug lagoon lair
  lake lamb lamp lance lancer landmark lane lantern lanyard larder lark lasso latch lattice laurel
  lavender lawn leaf leather ledge ledger leek legend lemon lemonade lemur lens lentil leopard
  letter lettuce levee lever levitate library lichen light lilac lilt lily lilypad lime limerick
  linden line linen lintel lion lizard llama lobster lock locket locust lodestar lodge loft log
  lollipop longboat longbow lookout loom lotus luck lullaby lumber lute lynx lyre mace madrigal
  magician magnolia magpie mailbox mallet mammoth manatee mandolin mango manor mansion mantis
  mantle map maple marble march mare marigold marina mariner market marmot marsh marten mascot
  mason mast mastiff maul maze meadow medal medusa meerkat melody melon mending mentor merchant
  merfolk meringue merlin mermaid mesa message meteor midnight milk mill millpond mimic miner
  minnow minotaur minstrel mint minuet mirage mirror mirth mist mitten moat mocha mole mongoose
  monk monkey monocle monolith monsoon moon moonbeam moor moorland moose mortar mosaic mosquito
  moss moth motor motto mountain mouse mud muffin mug mulberry mule murmur museum mushroom mustang
  mustard mystery mystic myth nail narwhal nautilus nebula necklace nectar needle nest net nettle
  newt nimbus nomad noodle nook noon north nova nugget nutmeg oak oar oarsman oasis oat oath
  oatmeal obelisk oboe obsidian ocarina ocean ocelot octagon octave octopus odyssey ogre okapi
  olive onion onyx opal oracle orange orb orbit orc orca orchard orchid oriole osprey ostrich
  otter outlaw outpost oval oven overture owl owlbear owlet oxcart oyster paddle paddock page
  pagoda painter palace paladin palisade palm pan pancake panda pansy panther pantry papaya paper
  parasol parcel parlor parrot parsley parsnip pasta pasture path pathway pavilion pawn pea peach
  peacock peak peanut pear pearl pebble pecan pegasus pelican pen pencil pendant penguin pennant
  pentagon peony pepper perch petal petunia pewter pheasant piano piccolo pickle picnic pie pier
  pig pigeon piglet pike pilgrim pillow pine pinecone pinnacle pinto pinwheel pirate piston
  pitcher piton pixie pizza plaid planet plateau platypus plaza plover plum plume poet polka
  pollen poncho pond pony pool poplar poppet poppy porch porridge portal postcard pot potato
  potion potter pottery pouch prairie pretzel primrose prince princess prism prune pudding puddle
  puffin pulley puma pumpkin puppet puppy purse puzzle pyramid python quail quarry quartz quasit
  queen quest quill quilt quince quiver rabbit raccoon radish raft rafter rain rainbow raisin
  rampart ranch ranger rapids rapier rat rattan rattle raven ravine realm recipe recorder redwood
  reed reef reel refrain reindeer relic rhino rhubarb ribbon rice riddle ridge ring ripple river
  rivulet road roadway robe robin robot roc rock rocket rod rogue rondo roof rooftop rooster root
  rope rose rosebud rowboat rubble ruby rucksack rudder rug ruins ruler rumble rune runway rush
  sack saddle saffron saga sage sail sailor salmon salt sand sandal sapling sapphire sardine
  satchel satyr sauna saw scallop scarf scarlet scepter schooner scimitar scooter scorpion scout
  scribe scroll scrying sculptor seahorse seal seashell season secret seed seer seesaw sending
  sentinel sentry sequoia serenade sesame sextant shade shadow shamrock shanty shark shatter sheep
  shelf shepherd shield shilling shimmer ship shipyard shoe shore shortbow shovel shower shrimp
  shrine shutter sickle sidekick sigil signet signpost silence silo silver singer skate ski skiff
  skunk sky skylark skyline slate sled sleep sleigh slide sling slipper sloop slope sloth slow
  smith smoke snail snow snowball snowdrop snowman sock soil solstice sonata song sonnet sorcerer
  soup south spark sparkle sparrow spear spell sphinx spider spinach spindle spinner spiral splash
  spool spoon spring sprite sprocket sprout spruce spyglass square squash squid squire squirrel
  stable stadium staff stag stairway stallion stamp star starfish starling statue steam steed
  steel steeple stem steppe stingray stirrup stockade stool stork stream street strudel student
  study stump sugar summer summit sun sunbeam sunburst sundae sundial sunrise sunset swallow swamp
  swan swing switch sword sycamore syrup table taco tadpole tailor talisman tambour tankard
  tapestry tapir tavern taxi tea teacher teacup teapot teleport tempest temple tent terrace
  thicket thimble thistle thorn thread throne thrush thunder thyme tiara ticket tide tiefling
  tiger tile tin tinker toad toast toboggan toffee tollgate tomato tomb tome tongs tongues top
  topaz torch tortoise toucan tower town towpath toy tractor trader trail train tram trapdoor
  treant treetop trellis triangle tricycle trident trinket triton troll trolley trombone trophy
  trout truck truffle trumpet trunk tsunami tuba tulip tuna tundra tune tunic tunnel turkey turnip
  turret turtle twig twilight twine twinkle umbrella unicorn upland urchin valley valve van
  vanilla vapor velvet veranda verse vessel vest vial villa village villain vine vineyard violet
  violin viper volcano vow voyage waffle wagon wall wallaby wallet walnut walrus waltz wand ward
  warden wardrobe warlock warren wave weasel weaver web well west wetland whale wharf wheat wheel
  whim whirl whisper whistle wick wicket widget wildcat willow wind windmill window wings winter
  wish wishbone wisteria wizard wolf wombat wonder woodland worg workshop worm wren wyvern xorn
  yak yam yardarm yarn yarrow yearling yeti yew yodel yoyo yurt zebra zephyr zeppelin zinnia
  zircon zombie
`
    .trim()
    .split(/\s+/),
);
