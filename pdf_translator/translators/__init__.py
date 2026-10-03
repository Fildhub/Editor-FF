from .base import Context, Item, TranslationCache, Translator, load_glossary, make_batches


def get_translator(engine: str, **kw) -> Translator:
    engine = engine.lower()
    if engine == "google":
        from .google import GoogleTranslator

        return GoogleTranslator()
    if engine == "file":
        from .manual import FileTranslator

        if not kw.get("path"):
            raise ValueError("--engine file needs --translations FILE.json")
        return FileTranslator(kw["path"])
    raise ValueError(f"unknown engine: {engine} (use google or file)")


__all__ = [
    "Context",
    "Item",
    "TranslationCache",
    "Translator",
    "get_translator",
    "load_glossary",
    "make_batches",
]
