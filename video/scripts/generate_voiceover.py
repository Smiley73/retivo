# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["kokoro-onnx==0.6.1", "soundfile==0.14.0"]
# ///
"""Generate a video's narration: one MP3 per line of its narration.json.

Run it from inside a video folder, or pass the folder:

    cd my-video && uv run --python 3.13 ../scripts/generate_voiceover.py
    uv run --python 3.13 scripts/generate_voiceover.py my-video

Output goes to <video>/public/voiceover/. Everything that should be the same in
every video is shared, one level up in video/:

    voice.json            which Kokoro voice, and how fast
    pronunciations.json   exact IPA for words the voice would get wrong
    models/               the Kokoro model files (see the README for the download)

VOICE=am_adam SPEED=0.95 in front of the command overrides voice.json once.

Uses Kokoro (https://github.com/thewh1teagle/kokoro-onnx), an open-source neural
voice that runs locally. Nothing is sent over the network. The Python packages are
pinned in the header above and locked in generate_voiceover.py.lock.

Words in pronunciations.json are spoken from their IPA instead of the voice's
default reading, so a word sounds the same in every clip of every video.

Prints each clip's length in 30 fps frames so scene timings can be checked
against the speech.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

FPS = 30
LANG = "en-us"
CLIP_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
WORD = re.compile(r"^[A-Za-z0-9]+$")

# A word ending in one of these takes "iz" for the possessive ("Rex's"), a voiceless
# stop or fricative takes "s" ("Pat's"), anything else "z" ("Retivo's").
_SIBILANT_ENDINGS = ("s", "z", "ʃ", "ʒ", "tʃ", "dʒ")
_VOICELESS_ENDINGS = ("p", "t", "k", "f", "θ")


def clip_problems(clips: list) -> list[str]:
    """Reasons a narration.json can't be used: bad, repeated or textless ids."""
    problems, seen = [], set()
    for index, clip in enumerate(clips):
        clip_id, text = clip.get("id"), clip.get("text")
        if not isinstance(clip_id, str) or not CLIP_ID.match(clip_id):
            problems.append(
                f"clip {index + 1}: id {clip_id!r} must be lower-case letters, digits and hyphens"
            )
        elif clip_id in seen:
            problems.append(f"clip {index + 1}: id {clip_id!r} is used twice")
        else:
            seen.add(clip_id)
        if not isinstance(text, str) or not text.strip():
            problems.append(f"clip {index + 1} ({clip_id}): no text")
    return problems


def possessive_suffix(ipa: str) -> str:
    """The sounds that turn a word into its possessive, from its last sound."""
    if ipa.endswith(_SIBILANT_ENDINGS):
        return "ɪz"
    if ipa.endswith(_VOICELESS_ENDINGS):
        return "s"
    return "z"


def dictionary_problems(words) -> list[str]:
    """Reasons a pronunciation dictionary can't be used: keys must be single words."""
    return [
        f"{word!r} must be a single word of letters and digits"
        for word in words
        if not WORD.match(word)
    ]


def dictionary_pattern(ipa_by_word: dict) -> "re.Pattern[str] | None":
    """Whole-word, case-insensitive matcher for the dictionary, with an optional 's."""
    if not ipa_by_word:
        return None
    words = "|".join(re.escape(word) for word in ipa_by_word)
    return re.compile(r"\b(" + words + r")(['’]s)?\b", re.IGNORECASE)


def to_phonemes(text: str, phonemize, ipa_by_word: dict) -> tuple[str, bool]:
    """Phonemes for `text`, with each dictionary word spoken as its exact IPA.

    The text up to and including a dictionary word is phonemized as one piece,
    and only that word's own phonemes, found at the end of it, are swapped for the
    IPA. That keeps the word before it read as it would be before the real word
    ("to" is "tuː" before a vowel and "tə" before a consonant) and keeps whatever
    sticks to the word: "non-Retivo" stays "non" plus the word, "(Retivo)" keeps
    its bracket.
    """
    pattern = dictionary_pattern(ipa_by_word)
    if pattern is None:
        return phonemize(text), False
    phonemes, position, used = "", 0, False
    for match in pattern.finditer(text):
        word = match.group(0)
        spoken = phonemize(word)  # the word's own phonemes, read on its own
        chunk = phonemize(text[position : match.end()])
        if not spoken or not chunk.endswith(spoken):
            raise ValueError(
                f"could not find the phonemes of {word!r} at the end of {chunk!r}"
            )
        ipa = ipa_by_word[match.group(1).lower()]
        if match.group(2):
            ipa += possessive_suffix(ipa)
        phonemes += chunk[: len(chunk) - len(spoken)] + ipa
        position, used = match.end(), True
        if text[position : position + 1].isspace():
            phonemes += " "
    rest = text[position:]
    if rest.strip():
        phonemes += phonemize(rest)
    return phonemes, used


def main() -> None:
    shared = Path(__file__).resolve().parent.parent  # video/
    project = Path(sys.argv[1] if len(sys.argv) > 1 else Path.cwd()).resolve()
    models = shared / "models"
    out = project / "public" / "voiceover"

    narration = project / "narration.json"
    if not narration.exists():
        raise SystemExit(f"{narration} not found: run this from a video folder, or pass its path")
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg not found: install it with `brew install ffmpeg`")
    for model_file in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        if not (models / model_file).exists():
            raise SystemExit(f"{models / model_file} not found: download it as the README describes")

    clips = json.loads(narration.read_text())
    problems = clip_problems(clips)
    if problems:
        raise SystemExit("narration.json:\n  " + "\n  ".join(problems))

    voice_config = json.loads((shared / "voice.json").read_text())
    voice = os.environ.get("VOICE", voice_config["voice"])
    speed = float(os.environ.get("SPEED", voice_config["speed"]))

    # Imported here so the helpers above can be tested without the model's packages.
    import soundfile as sf
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(str(models / "kokoro-v1.0.onnx"), str(models / "voices-v1.0.bin"))
    phonemize = lambda text: kokoro.tokenizer.phonemize(text, LANG)  # noqa: E731

    ipa_by_word = {}
    pronunciations = shared / "pronunciations.json"
    if pronunciations.exists():
        entries = json.loads(pronunciations.read_text())
        problems = dictionary_problems(entries)
        if problems:
            raise SystemExit("pronunciations.json:\n  " + "\n  ".join(problems))
        for word, entry in entries.items():
            unknown = [c for c in entry["ipa"] if c not in kokoro.tokenizer.vocab]
            if unknown:
                raise SystemExit(
                    f"pronunciations.json: {word!r} uses symbols Kokoro does not know: {unknown}"
                )
            ipa_by_word[word.lower()] = entry["ipa"]

    out.mkdir(parents=True, exist_ok=True)
    print(f"{project.name}: voice {voice}, speed {speed}")

    for clip in clips:
        phonemes, used_dictionary = to_phonemes(clip["text"], phonemize, ipa_by_word)
        samples, rate = kokoro.create(
            phonemes, voice=voice, speed=speed, lang=LANG, is_phonemes=True
        )
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "clip.wav"
            sf.write(wav, samples, rate)
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
                 "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100", "-ac", "1", "-b:a", "128k",
                 str(out / f"{clip['id']}.mp3")],
                check=True,
            )
        seconds = len(samples) / rate
        print(f"{clip['id']:<10} {seconds:5.2f}s  {int(seconds * FPS) + 1:4d} frames")
        if used_dictionary:
            print(f"{'':<10} phonemes: {phonemes}")

    # Clips of lines that were renamed or removed would otherwise linger.
    wanted = {clip["id"] for clip in clips}
    for stale in sorted(out.glob("*.mp3")):
        if stale.stem not in wanted:
            stale.unlink()
            print(f"removed stale clip {stale.name}")


if __name__ == "__main__":
    main()
