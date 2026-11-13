FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl git socat libreoffice-writer libreoffice-calc libreoffice-impress \
    fonts-dejavu-core poppler-utils && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir python-docx openpyxl python-pptx reportlab pypdf \
    pillow matplotlib numpy sympy requests
COPY watchdog.py /opt/verfix-watchdog.py
ENV HOME=/work HTTP_PROXY=http://127.0.0.1:3128 HTTPS_PROXY=http://127.0.0.1:3128 \
    http_proxy=http://127.0.0.1:3128 https_proxy=http://127.0.0.1:3128 \
    PYTHONPATH=/work/packages MPLCONFIGDIR=/work/.mpl
WORKDIR /work
USER 65534:65534
CMD ["/usr/local/bin/python", "-I", "/opt/verfix-watchdog.py"]
