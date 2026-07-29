# Presidio Analyzer with a clinical de-identification model.
#
# The stock mcr.microsoft.com/presidio-analyzer image detects names, dates and
# places with spaCy's general-purpose en_core_web_lg. This image swaps in
# StanfordAIMI/stanford-deidentifier-base (PubMedBERT fine-tuned for PHI
# de-identification; MIT licence, reported F1 97.9-99.6 on radiology and i2b2),
# which is substantially better on clinical prose, and adds a UK postcode
# recognizer alongside Presidio's built-in UK NHS number recognizer.
#
# Everything is baked in: torch, transformers, the spaCy tokenizer and the
# model weights. The running container needs no network access.
#
#   docker build -t document-ocr-extractor-presidio:latest docker/presidio
#
# Or bring up analyzer + anonymizer together with docker/presidio/compose.yaml.

FROM mcr.microsoft.com/presidio-analyzer:latest

# The base image runs as uid 1001; installing needs root. We drop back at the end.
USER root

# CPU-only torch. The default PyPI wheel pulls in the CUDA runtime (~2 GB of
# libraries this workload never uses), so pin the CPU index explicitly.
#
# spacy-huggingface-pipelines is the package Presidio actually gates on:
# TransformersNlpEngine.is_available is `bool(spacy_huggingface_pipelines)`, so
# without it the engine silently reports "not available" and the worker exits,
# even with torch and transformers installed.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
    && pip install --no-cache-dir transformers spacy-huggingface-pipelines

# spaCy is still required by the transformers NLP engine, but only for
# tokenization - en_core_web_sm (~12 MB) is enough; all NER comes from the
# transformer.
RUN python -m spacy download en_core_web_sm

# Bake the model weights so the analyzer never reaches HuggingFace at runtime.
# allow_patterns skips the README and .gitattributes; this repo ships
# pytorch_model.bin (no safetensors).
RUN python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download( \
    'StanfordAIMI/stanford-deidentifier-base', \
    local_dir='/models/stanford-deidentifier-base', \
    allow_patterns=['config.json', 'pytorch_model.bin', 'special_tokens_map.json', 'tokenizer_config.json', 'vocab.txt'], \
)"

# NLP engine config (points at the baked model) and the recognizer registry,
# built by merging our extras into the image's own defaults so no built-in
# recognizer is lost.
RUN mkdir -p /conf
COPY nlp-transformers.yaml /conf/nlp-transformers.yaml
COPY uk-postcode-recognizer.yaml /tmp/uk-postcode-recognizer.yaml
COPY build-recognizers.py /tmp/build-recognizers.py
RUN python /tmp/build-recognizers.py && chmod -R a+rX /conf /models

ENV NLP_CONF_FILE=/conf/nlp-transformers.yaml \
    RECOGNIZER_REGISTRY_CONF_FILE=/conf/recognizers.yaml

# Never phone home for weights: fail loudly rather than silently downloading.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

USER 1001
