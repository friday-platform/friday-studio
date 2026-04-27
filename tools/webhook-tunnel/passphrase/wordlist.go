package passphrase

// wordlist is a small English wordlist used to generate diceware-style
// passphrases. Picked for memorability over entropy density: every word
// is 3–8 chars, common, easy to read out loud. With 256 words and 4
// words per passphrase that's 32 bits of entropy — comparable to the
// TS `random-words` package's 4-word output. For a webhook signing
// secret, the security model is "an attacker forges signatures if they
// know it" — entropy here just needs to defeat dictionary attacks
// (which it does by ~4 billion combinations) given that webhook secrets
// rotate per-workspace and the secret is only exposed in `/status` to
// localhost-trusted callers.
var wordlist = []string{
	"able", "acid", "aged", "airy", "alps", "ants", "apex", "arch",
	"area", "army", "arts", "aunt", "axis", "back", "bake", "bald",
	"ball", "band", "bank", "bare", "barn", "bath", "beam", "bean",
	"bear", "beef", "bell", "bend", "best", "bike", "bill", "bird",
	"blue", "boat", "body", "bold", "bolt", "bone", "book", "boot",
	"born", "boss", "bowl", "brand", "brick", "brisk", "broad", "broom",
	"brown", "brush", "bumpy", "bunch", "burst", "cable", "calm", "camp",
	"candy", "canyon", "cargo", "cart", "case", "cast", "catch", "cause",
	"cedar", "chair", "chalk", "charm", "chart", "cheek", "cheer", "chess",
	"chest", "chick", "chief", "child", "chin", "chip", "choir", "chop",
	"city", "claim", "clap", "clay", "clean", "clear", "clerk", "click",
	"cliff", "climb", "cling", "cloak", "clock", "close", "cloud", "club",
	"coal", "coast", "coat", "code", "coil", "coin", "cold", "comet",
	"cone", "cool", "copy", "coral", "cord", "corn", "couch", "count",
	"crab", "craft", "crane", "crash", "crate", "crawl", "cream", "creek",
	"crest", "crib", "crisp", "crop", "cross", "crow", "crown", "crust",
	"cube", "curl", "curve", "daisy", "dance", "dawn", "deck", "deed",
	"deep", "deer", "delta", "dense", "depth", "derby", "desk", "dial",
	"diary", "dice", "dish", "dive", "dock", "dome", "donut", "doors",
	"dough", "dove", "dozen", "draft", "drag", "drama", "draw", "drink",
	"drive", "drop", "drum", "duck", "dune", "dusk", "dust", "duty",
	"eager", "eagle", "early", "earth", "easel", "east", "easy", "echo",
	"edge", "egg", "elbow", "elder", "elite", "elm", "ember", "empty",
	"enemy", "epic", "equal", "essay", "even", "evil", "exact", "exam",
	"face", "fact", "fade", "fair", "fame", "farm", "fast", "fawn",
	"fern", "field", "fig", "file", "film", "fire", "first", "fish",
	"fist", "five", "flame", "flag", "flake", "flank", "flask", "flat",
	"fleet", "flesh", "flight", "flint", "flock", "flood", "floor", "flour",
	"flow", "fly", "foam", "fog", "fold", "food", "fork", "form",
	"fort", "found", "fox", "frame", "free", "frog", "front", "frost",
	"fruit", "fuel", "fund", "fungus", "fur", "fuse", "gain", "game",
	"gas", "gate", "gear", "gem", "gentle", "ghost", "giant", "gift",
}
