# train_6class.py
import os
import numpy as np
import tensorflow as tf
import tensorflow_hub as hub
import librosa
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.utils.class_weight import compute_class_weight
from sklearn.metrics import classification_report, confusion_matrix
import matplotlib.pyplot as plt
import seaborn as sns

# ── CONFIG ──────────────────────────────────────────────────────────────
DATASETS_DIR  = Path(r'C:\Users\samar\Desktop\El\DATASETS')
SAVE_DIR      = Path(r'C:\Users\samar\Desktop\El')
SR            = 16000
SEGMENT_DUR   = 3.0      # seconds per segment
BATCH_SIZE    = 32
EPOCHS        = 50
RANDOM_STATE  = 42

CLASSES = ['Background', 'Dog', 'GlassBreak', 'Gunshots', 'Scream', 'Siren']
N_CLASSES = len(CLASSES)

# ── LOAD YAMNET ──────────────────────────────────────────────────────────
print("Loading YAMNet...")
yamnet = hub.load('https://tfhub.dev/google/yamnet/1')
print("YAMNet loaded.\n")

# ── FEATURE EXTRACTION ───────────────────────────────────────────────────
def extract_embedding(file_path):
    """Load wav, segment into 3s chunks, extract YAMNet embeddings."""
    try:
        y, _ = librosa.load(file_path, sr=SR, mono=True)
    except Exception as e:
        print(f"  Error loading {file_path}: {e}")
        return []

    target_len = int(SR * SEGMENT_DUR)
    embeddings = []

    # If clip shorter than 3s, pad and use as single segment
    if len(y) < target_len:
        y = np.pad(y, (0, target_len - len(y)))
        y = y.astype(np.float32)
        _, emb, _ = yamnet(y)
        embeddings.append(np.mean(emb.numpy(), axis=0))
    else:
        # Slide through the clip in 3s chunks
        for start in range(0, len(y) - target_len + 1, target_len):
            chunk = y[start:start + target_len].astype(np.float32)
            _, emb, _ = yamnet(chunk)
            embeddings.append(np.mean(emb.numpy(), axis=0))

    return embeddings  # list of 1024-dim vectors


def load_all_data():
    X, y = [], []
    for label_idx, class_name in enumerate(CLASSES):
        folder = DATASETS_DIR / class_name
        if not folder.exists():
            print(f"WARNING: folder not found: {folder}")
            continue
        files = list(folder.glob('*.wav'))
        print(f"Processing {class_name}: {len(files)} files...")
        for f in files:
            embeddings = extract_embedding(f)
            for emb in embeddings:
                X.append(emb)
                y.append(label_idx)
    return np.array(X), np.array(y)


# ── LOAD DATA ────────────────────────────────────────────────────────────
print("Extracting embeddings from all classes...")
print("This will take 10-20 minutes. Go get a coffee.\n")
X, y = load_all_data()

print(f"\nTotal segments: {len(X)}")
print(f"Embedding shape: {X.shape}")
print("\nPer-class segment counts:")
for i, cls in enumerate(CLASSES):
    print(f"  {cls}: {np.sum(y == i)}")

# Save embeddings so you don't recompute next time
np.save(SAVE_DIR / 'X_6class.npy', X)
np.save(SAVE_DIR / 'y_6class.npy', y)
print("\nEmbeddings saved to disk.")

# ── SPLIT ────────────────────────────────────────────────────────────────
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, stratify=y, random_state=RANDOM_STATE
)
X_train, X_val, y_train, y_val = train_test_split(
    X_train, y_train, test_size=0.2, stratify=y_train, random_state=RANDOM_STATE
)

print(f"\nTrain: {len(X_train)} | Val: {len(X_val)} | Test: {len(X_test)}")

# ── CLASS WEIGHTS ────────────────────────────────────────────────────────
class_weights = compute_class_weight(
    class_weight='balanced',
    classes=np.unique(y_train),
    y=y_train
)
class_weight_dict = dict(enumerate(class_weights))
print("\nClass weights:")
for i, cls in enumerate(CLASSES):
    print(f"  {cls}: {class_weights[i]:.4f}")

# ── MODEL ─────────────────────────────────────────────────────────────────
def build_model():
    inputs = tf.keras.Input(shape=(1024,))

    x = tf.keras.layers.Dense(512, activation='relu')(inputs)
    x = tf.keras.layers.BatchNormalization()(x)
    x = tf.keras.layers.Dropout(0.4)(x)

    x = tf.keras.layers.Dense(256, activation='relu')(x)
    x = tf.keras.layers.BatchNormalization()(x)
    x = tf.keras.layers.Dropout(0.3)(x)

    x = tf.keras.layers.Dense(128, activation='relu')(x)
    x = tf.keras.layers.Dropout(0.2)(x)

    outputs = tf.keras.layers.Dense(N_CLASSES, activation='softmax')(x)

    return tf.keras.Model(inputs, outputs)

model = build_model()
model.summary()

model.compile(
    optimizer=tf.keras.optimizers.Adam(learning_rate=0.001),
    loss='sparse_categorical_crossentropy',
    metrics=['accuracy']
)

callbacks = [
    tf.keras.callbacks.ModelCheckpoint(
        str(SAVE_DIR / 'best_6class_model.keras'),
        monitor='val_accuracy',
        save_best_only=True,
        verbose=1
    ),
    tf.keras.callbacks.ReduceLROnPlateau(
        monitor='val_loss',
        factor=0.5,
        patience=4,
        verbose=1,
        min_lr=1e-6
    ),
    tf.keras.callbacks.EarlyStopping(
        monitor='val_accuracy',
        patience=8,
        restore_best_weights=True,
        verbose=1
    )
]

# ── TRAIN ─────────────────────────────────────────────────────────────────
print("\nStarting training...")
history = model.fit(
    X_train, y_train,
    validation_data=(X_val, y_val),
    epochs=EPOCHS,
    batch_size=BATCH_SIZE,
    class_weight=class_weight_dict,
    callbacks=callbacks
)

# ── EVALUATE ──────────────────────────────────────────────────────────────
print("\nEvaluating on test set...")
y_pred = np.argmax(model.predict(X_test), axis=1)

print("\n" + "="*60)
print(classification_report(y_test, y_pred, target_names=CLASSES))
print("="*60)

# Confusion matrix
cm = confusion_matrix(y_test, y_pred)
plt.figure(figsize=(10, 8))
sns.heatmap(cm, annot=True, fmt='d',
            xticklabels=CLASSES, yticklabels=CLASSES,
            cmap='Blues')
plt.ylabel('Actual')
plt.xlabel('Predicted')
plt.title('6-Class Confusion Matrix')
plt.tight_layout()
plt.savefig(str(SAVE_DIR / 'confusion_matrix_6class.png'), dpi=100)
plt.show()

# Accuracy/Loss plots
fig, axes = plt.subplots(1, 2, figsize=(12, 4))
axes[0].plot(history.history['accuracy'],    label='Train')
axes[0].plot(history.history['val_accuracy'],label='Val')
axes[0].set_title('Accuracy')
axes[0].legend()
axes[1].plot(history.history['loss'],    label='Train')
axes[1].plot(history.history['val_loss'],label='Val')
axes[1].set_title('Loss')
axes[1].legend()
plt.tight_layout()
plt.savefig(str(SAVE_DIR / 'training_plots_6class.png'), dpi=100)
plt.show()

# ── CONVERT TO TFLITE ─────────────────────────────────────────────────────
print("\nConverting to TFLite...")
converter = tf.lite.TFLiteConverter.from_keras_model(model)
converter.optimizations = [tf.lite.Optimize.DEFAULT]
tflite_model = converter.convert()

tflite_path = SAVE_DIR / 'audio_classifier_6class.tflite'
with open(tflite_path, 'wb') as f:
    f.write(tflite_model)

print(f"TFLite model: {len(tflite_model)/1024:.1f} KB")
print(f"\nAll files saved to: {SAVE_DIR}")
print("Done!")