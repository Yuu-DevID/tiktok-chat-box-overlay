use std::sync::LazyLock;

// Thai profanity filter, ported 1:1 from the Node server. A matching comment
// is dropped before it reaches any overlay or TTS, never marked as filtered.
static SEPARATORS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"[\s\u{200B}-\u{200D}\u{FEFF}.,\-_*~!?'"`|/\\+=:;()\[\]{}<>^]+"#).unwrap());
static ALLOWED: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new("ขวยเขิน|เขินขวย").unwrap());
static LOOKALIKE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"[\u{0A80}-\u{0AFF}]").unwrap());
static PROFANITY: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
    fancy_regex::Regex::new(
        r"[คขฆฅ][็่-๋]*ว[็่-์]*(?:[ก-ฮ]์)?ย|ห(?:ี[่-๋]?|ิ[่-๋])(?![ก-ฮ])|แหย่ห[ิี]|เห?งี[่-๋]ยน|น้[ำา]ม?แต[กค]|[คขฆฅซ][็่-๋]*ว[็่-๋]*[ก-ฮ]์|อม[คขฆฅซ][็่-๋]*ว[็่-๋]*ย|[หฮอ][ก-ฮ]์[ิี]|ห[ก-ฮ]์|ฏู[ดฏ]|[ตฏ]ูฏ|เ[ลร]ีย[ตฏ]ู[ดฏ]|จับนม|นม์",
    )
    .unwrap()
});

pub fn is_profane_comment(text: &str) -> bool {
    if LOOKALIKE.is_match(text) {
        return true;
    }
    let mut normalized = SEPARATORS.replace_all(text, "").to_string();
    // Collapse runs like "ควววย" the way the original JS did.
    let mut collapsed = String::with_capacity(normalized.len());
    let mut previous: Option<char> = None;
    for ch in normalized.chars() {
        if previous != Some(ch) {
            collapsed.push(ch);
        }
        previous = Some(ch);
    }
    normalized = ALLOWED.replace_all(&collapsed, "").to_string();
    PROFANITY.is_match(&normalized).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_common_spellings() {
        assert!(is_profane_comment("ควย"));
        assert!(is_profane_comment("ค ว ย"));
        assert!(is_profane_comment("ควววย"));
        assert!(is_profane_comment("หี"));
        assert!(is_profane_comment("นม์"));
        assert!(is_profane_comment("ખૂઐ"));
    }

    #[test]
    fn keeps_real_words_and_normal_chat() {
        assert!(!is_profane_comment("ขวยเขิน"));
        assert!(!is_profane_comment("hello from Indonesia!"));
        assert!(!is_profane_comment("playing around"));
        assert!(!is_profane_comment("หีบ"));
        assert!(!is_profane_comment("หิ้ว"));
        assert!(!is_profane_comment("เหงียน"));
    }
}
