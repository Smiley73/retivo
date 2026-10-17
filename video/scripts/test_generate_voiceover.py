"""Tests for the helpers in generate_voiceover.py (no model needed).

Run from video/: python3 -m unittest discover -s scripts -p 'test_*.py'
"""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "generate_voiceover", Path(__file__).with_name("generate_voiceover.py")
)
gv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gv)

IPA = {"retivo": "IPA"}


def fake_phonemize(text: str) -> str:
    """Stand-in for espeak: upper-cases words, keeps punctuation, and reads "to"
    as TƏ before a consonant but TUː before a vowel or at the end of the text."""
    words = text.split()
    spoken = []
    for index, raw in enumerate(words):
        word = raw.rstrip('.,!?)"\'')
        trailing = raw[len(word) :]
        following = words[index + 1][0].lower() if index + 1 < len(words) else " "
        if word.lower() == "to":
            spoken.append(("TƏ" if following not in "aeiou " else "TUː") + trailing)
        else:
            spoken.append(word.upper() + trailing)
    return " ".join(spoken)


class ClipProblems(unittest.TestCase):
    def test_accepts_clean_clips(self):
        clips = [{"id": "title-1", "text": "Hello."}, {"id": "step-2", "text": "Next."}]
        self.assertEqual(gv.clip_problems(clips), [])

    def test_rejects_ids_that_could_escape_the_output_folder(self):
        for bad in ["../x", "a/b", "Title", "", "-x", "a b"]:
            problems = gv.clip_problems([{"id": bad, "text": "Hi"}])
            self.assertEqual(len(problems), 1, bad)

    def test_rejects_repeated_ids_and_missing_text(self):
        clips = [{"id": "a", "text": "One."}, {"id": "a", "text": "Two."}, {"id": "b", "text": " "}]
        problems = gv.clip_problems(clips)
        self.assertEqual(len(problems), 2)
        self.assertIn("used twice", problems[0])
        self.assertIn("no text", problems[1])


class DictionaryProblems(unittest.TestCase):
    def test_accepts_single_words(self):
        self.assertEqual(gv.dictionary_problems(["Retivo", "Smiley73"]), [])

    def test_rejects_keys_that_are_not_one_word(self):
        for bad in ["social security", "", "Re-tivo", " Retivo"]:
            self.assertEqual(len(gv.dictionary_problems([bad])), 1, repr(bad))


class PossessiveSuffix(unittest.TestCase):
    def test_follows_the_last_sound(self):
        self.assertEqual(gv.possessive_suffix("ɹɛtˈiːvoʊ"), "z")
        self.assertEqual(gv.possessive_suffix("pˈæt"), "s")
        self.assertEqual(gv.possessive_suffix("ɹˈɛks"), "ɪz")
        self.assertEqual(gv.possessive_suffix("bˈɹɪdʒ"), "ɪz")


class ToPhonemes(unittest.TestCase):
    def test_without_a_dictionary_it_phonemizes_the_text_as_is(self):
        self.assertEqual(gv.to_phonemes("Hello there.", fake_phonemize, {}), ("HELLO THERE.", False))

    def test_swaps_only_the_dictionary_word(self):
        phonemes, used = gv.to_phonemes("Say Retivo, locally.", fake_phonemize, IPA)
        self.assertEqual(phonemes, "SAY IPA, LOCALLY.")
        self.assertTrue(used)

    def test_the_word_before_it_is_read_as_before_the_real_word(self):
        # "to" must see the real word's consonant, not the end of a fragment.
        phonemes, _ = gv.to_phonemes("Welcome to Retivo.", fake_phonemize, IPA)
        self.assertEqual(phonemes, "WELCOME TƏ IPA.")

    def test_matches_whole_words_in_any_case_and_with_a_possessive(self):
        self.assertEqual(gv.to_phonemes("RETIVO", fake_phonemize, IPA)[0], "IPA")
        self.assertEqual(gv.to_phonemes("retivo's app", fake_phonemize, IPA)[0], "IPAz APP")
        self.assertEqual(gv.to_phonemes("Retivo’s app", fake_phonemize, IPA)[0], "IPAz APP")
        self.assertEqual(gv.to_phonemes("Retivos app", fake_phonemize, IPA), ("RETIVOS APP", False))

    def test_keeps_whatever_sticks_to_the_word(self):
        self.assertEqual(
            gv.to_phonemes("Try non-Retivo users", fake_phonemize, IPA)[0],
            "TRY NON-IPA USERS",
        )
        self.assertEqual(
            gv.to_phonemes("(Retivo) is local", fake_phonemize, IPA)[0],
            "(IPA) IS LOCAL",
        )
        self.assertEqual(
            gv.to_phonemes('"Retivo" is local', fake_phonemize, IPA)[0],
            '"IPA" IS LOCAL',
        )

    def test_fails_loudly_when_the_word_cannot_be_found_in_the_phonemes(self):
        def odd(text: str) -> str:
            return "B" if text == "Retivo" else "A"

        with self.assertRaises(ValueError):
            gv.to_phonemes("Say Retivo", odd, IPA)

    def test_several_occurrences(self):
        phonemes, _ = gv.to_phonemes("Retivo and Retivo", fake_phonemize, IPA)
        self.assertEqual(phonemes, "IPA AND IPA")


if __name__ == "__main__":
    unittest.main()
