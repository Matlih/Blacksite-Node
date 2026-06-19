use image::ImageFormat;
use std::fs;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum StegoError {
    #[error("I/O Error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Image Error: {0}")]
    Image(#[from] image::ImageError),
    #[error("Carrier image is too small to hold the payload. Need {0} pixels, but image has {1}.")]
    CarrierTooSmall(usize, usize),
    #[error("No steganographic payload detected in this file.")]
    NoPayloadDetected,
    #[error("LSB extraction failed: corrupted or missing marker.")]
    CorruptedLsb,
}

const MAGIC_MARKER: &[u8] = b"<<BLACKSITE_STEGO_v1>>";

/// Embeds payload via EOF Injection (Universal)
pub fn embed_eof(carrier_path: &PathBuf, dest_path: &PathBuf, payload: &[u8]) -> Result<(), StegoError> {
    let mut data = fs::read(carrier_path)?;
    data.extend_from_slice(MAGIC_MARKER);
    data.extend_from_slice(payload);
    fs::write(dest_path, data)?;
    Ok(())
}

/// Extracts payload from EOF Injection (Universal)
pub fn extract_eof(source_path: &PathBuf) -> Result<Vec<u8>, StegoError> {
    let data = fs::read(source_path)?;
    // Search backwards for the marker for efficiency
    if let Some(pos) = data.windows(MAGIC_MARKER.len()).rev().position(|window| window == MAGIC_MARKER) {
        let exact_pos = data.len() - pos - MAGIC_MARKER.len();
        let payload = &data[exact_pos + MAGIC_MARKER.len()..];
        return Ok(payload.to_vec());
    }
    Err(StegoError::NoPayloadDetected)
}

/// Embeds payload via LSB (Least Significant Bit) Pixel Modification (PNG only)
pub fn embed_lsb(carrier_path: &PathBuf, dest_path: &PathBuf, payload: &[u8]) -> Result<(), StegoError> {
    let img = image::open(carrier_path)?.into_rgba8();
    let width = img.width();
    let height = img.height();
    let mut raw_pixels = img.into_raw();

    // Prepare full data stream: [Length (4 bytes)][Magic Marker][Payload]
    let total_len = MAGIC_MARKER.len() + payload.len();
    let mut full_data = Vec::with_capacity(4 + total_len);
    full_data.extend_from_slice(&(total_len as u32).to_le_bytes());
    full_data.extend_from_slice(MAGIC_MARKER);
    full_data.extend_from_slice(payload);

    let required_bytes = full_data.len() * 8;
    if required_bytes > raw_pixels.len() {
        return Err(StegoError::CarrierTooSmall(required_bytes / 4, raw_pixels.len() / 4));
    }

    let mut bit_idx = 0;
    for byte in full_data.iter() {
        for bit_pos in 0..8 {
            let bit = (byte >> (7 - bit_pos)) & 1;
            raw_pixels[bit_idx] = (raw_pixels[bit_idx] & 0xFE) | bit;
            bit_idx += 1;
        }
    }

    let new_img = image::RgbaImage::from_raw(width, height, raw_pixels).unwrap();
    new_img.save_with_format(dest_path, ImageFormat::Png)?;
    Ok(())
}

/// Extracts payload from LSB (Least Significant Bit)
pub fn extract_lsb(source_path: &PathBuf) -> Result<Vec<u8>, StegoError> {
    let img = image::open(source_path)?.into_rgba8();
    let raw_pixels = img.into_raw();

    if raw_pixels.len() < 32 {
        return Err(StegoError::NoPayloadDetected);
    }

    // Read the first 32 bits (4 bytes) to get the payload length
    let mut len_bytes = [0u8; 4];
    for i in 0..4 {
        let mut b = 0u8;
        for j in 0..8 {
            let pixel_bit = raw_pixels[i * 8 + j] & 1;
            b = (b << 1) | pixel_bit;
        }
        len_bytes[i] = b;
    }
    
    let total_len = u32::from_le_bytes(len_bytes) as usize;
    if total_len == 0 || total_len > raw_pixels.len() / 8 {
        return Err(StegoError::NoPayloadDetected);
    }

    let required_bits = 32 + (total_len * 8);
    if required_bits > raw_pixels.len() {
        return Err(StegoError::CorruptedLsb);
    }

    let mut extracted = Vec::with_capacity(total_len);
    for i in 0..total_len {
        let mut b = 0u8;
        for j in 0..8 {
            let pixel_bit = raw_pixels[32 + (i * 8) + j] & 1;
            b = (b << 1) | pixel_bit;
        }
        extracted.push(b);
    }

    // Verify magic marker
    if extracted.len() < MAGIC_MARKER.len() || &extracted[..MAGIC_MARKER.len()] != MAGIC_MARKER {
        return Err(StegoError::CorruptedLsb);
    }

    Ok(extracted[MAGIC_MARKER.len()..].to_vec())
}
