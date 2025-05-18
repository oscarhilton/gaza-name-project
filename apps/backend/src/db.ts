import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';

const pool = new Pool({
  user: process.env.DB_USER || 'gaza_name_user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'gaza_name_project_db',
  password: process.env.DB_PASSWORD || 'your_secure_password',
  port: parseInt(process.env.DB_PORT || '5432'),
});

export const connectToDB = async () => {
  try {
    await pool.query('SELECT NOW()');
    console.log('Successfully connected to PostgreSQL database.');
  } catch (err) {
    console.error('Error connecting to PostgreSQL database:', err);
  }
};

export const createMartyrsTable = async () => {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS martyrs (
      db_id SERIAL PRIMARY KEY,
      source_id VARCHAR(255) UNIQUE,
      name TEXT NOT NULL,
      en_name TEXT NOT NULL,
      dob DATE,
      sex CHAR(1),
      age INTEGER,
      source_info CHAR(1),
      is_recorded BOOLEAN DEFAULT FALSE NOT NULL,
      recorded_at TIMESTAMP WITH TIME ZONE,
      processed_audio_path TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await pool.query(createTableQuery);
    console.log('Martyrs table schema checked/created successfully.');
    const alterTableQuery = `
      ALTER TABLE martyrs
      ADD COLUMN IF NOT EXISTS processed_audio_path TEXT;
    `;
    await pool.query(alterTableQuery);
    console.log('Checked/Ensured processed_audio_path column exists in martyrs table.');
  } catch (err) {
    console.error('Error ensuring martyrs table schema:', err);
  }
};

export const insertMartyrs = async (martyrsData: any[]) => {
  if (!martyrsData || martyrsData.length === 0) {
    return { insertedCount: 0, skippedCount: 0 };
  }
  let insertedCount = 0;
  let skippedCount = 0;
  await createMartyrsTable(); // Ensure table exists
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const martyr of martyrsData) {
      const enName = martyr.en_name?.trim();
      const sourceId = martyr.id?.trim() || null;
      const arabicName = martyr.name?.trim();
      if (!enName || !arabicName) {
        skippedCount++;
        continue;
      }
      let checkQuery, checkValues;
      if (sourceId) {
        checkQuery = 'SELECT db_id FROM martyrs WHERE source_id = $1';
        checkValues = [sourceId];
      } else {
        checkQuery = 'SELECT db_id FROM martyrs WHERE en_name = $1';
        checkValues = [enName];
      }
      const { rows: existingRows } = await client.query(checkQuery, checkValues);
      if (existingRows.length > 0) {
        skippedCount++;
        continue;
      }
      const dob = martyr.dob && martyr.dob !== '' ? martyr.dob : null;
      const sex = martyr.sex?.toLowerCase() === 'm' || martyr.sex?.toLowerCase() === 'f' ? martyr.sex.toLowerCase() : null;
      const age = typeof martyr.age === 'number' && !isNaN(martyr.age) ? martyr.age : null;
      const sourceInfo = martyr.source?.trim() || null;
      const insertQuery = `
        INSERT INTO martyrs (source_id, name, en_name, dob, sex, age, source_info, is_recorded)
        VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
        RETURNING db_id;
      `;
      await client.query(insertQuery, [sourceId, arabicName, enName, dob, sex, age, sourceInfo]);
      insertedCount++;
    }
    await client.query('COMMIT');
    console.log(`Inserted ${insertedCount} new martyrs, skipped ${skippedCount} duplicates/invalid records.`);
    return { insertedCount, skippedCount };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during batch insert of martyrs:', err);
    throw err;
  } finally {
    client.release();
  }
};

export const getUnrecordedNames = async (limit: number = 100) => {
  await createMartyrsTable(); 
  const query = `
    SELECT db_id, en_name, name, age, sex
    FROM martyrs
    WHERE is_recorded = FALSE
    ORDER BY db_id 
    LIMIT $1;
  `;
  try {
    const { rows } = await pool.query(query, [limit]);
    return rows;
  } catch (err) {
    console.error('Error fetching unrecorded names:', err);
    throw err;
  }
};

export const markNameAsRecorded = async (dbId: number) => {
  if (!dbId) return { success: false, message: 'No ID provided.' };
  const query = `
    UPDATE martyrs
    SET is_recorded = TRUE, recorded_at = CURRENT_TIMESTAMP
    WHERE db_id = $1 AND is_recorded = FALSE
    RETURNING db_id, en_name;
  `;
  try {
    const { rows } = await pool.query(query, [dbId]);
    if (rows && rows.length > 0) {
      return { success: true, message: `Marked ${rows[0].en_name} as recorded.`, updatedName: rows[0] };
    } else {
      const checkExistedQuery = 'SELECT is_recorded FROM martyrs WHERE db_id = $1';
      const { rows: checkRows } = await pool.query(checkExistedQuery, [dbId]);
      if (checkRows.length > 0 && checkRows[0].is_recorded) {
        return { success: false, message: 'Name was already recorded.' };
      }
      return { success: false, message: 'No unrecorded name found.' };
    }
  } catch (err) {
    console.error(`Error marking name ${dbId} as recorded:`, err);
    return { success: false, message: 'DB error.', error: err };
  }
};

export const markNameAsUnrecorded = async (dbId: number) => {
  if (!dbId) return { success: false, message: 'No ID provided.' };
  const query = `
    UPDATE martyrs
    SET is_recorded = FALSE, recorded_at = NULL, processed_audio_path = NULL
    WHERE db_id = $1
    RETURNING db_id, en_name;
  `;
  try {
    const { rows } = await pool.query(query, [dbId]);
    if (rows && rows.length > 0) {
      return { success: true, message: `Marked ${rows[0].en_name} as unrecorded.`, updatedName: rows[0] };
    } else {
      return { success: false, message: 'No name found with that ID.' };
    }
  } catch (err) {
    console.error(`Error marking name ${dbId} as unrecorded:`, err);
    return { success: false, message: 'DB error.', error: err };
  }
};

export const updateProcessedAudioPath = async (dbId: number, filePath: string) => {
  if (!dbId || !filePath) return { success: false, message: 'Missing ID or path.' };
  const query = `UPDATE martyrs SET processed_audio_path = $2 WHERE db_id = $1;`;
  try {
    await pool.query(query, [dbId, filePath]);
    return { success: true, message: 'Updated audio path.' };
  } catch (err) {
    console.error(`Error updating audio path for ${dbId}:`, err);
    return { success: false, message: 'DB error.', error: err };
  }
};

export const getRecordedAudioPaths = async () => {
  const query = `
    SELECT processed_audio_path FROM martyrs 
    WHERE is_recorded = TRUE AND processed_audio_path IS NOT NULL AND processed_audio_path != ''
    ORDER BY recorded_at;
  `;
  try {
    const { rows } = await pool.query(query);
    return rows.map(row => row.processed_audio_path);
  } catch (err) {
    console.error('Error fetching audio paths:', err);
    throw err;
  }
};

export const getPaginatedRecordedSegments = async (page: number, limit: number) => {
  const offset = (page - 1) * limit;
  const query = `
    SELECT db_id, en_name, name, age, sex, processed_audio_path
    FROM martyrs
    WHERE is_recorded = TRUE AND processed_audio_path IS NOT NULL AND processed_audio_path != ''
    ORDER BY recorded_at DESC
    LIMIT $1 OFFSET $2;
  `;
  const countQuery = `SELECT COUNT(*) FROM martyrs WHERE is_recorded = TRUE AND processed_audio_path IS NOT NULL AND processed_audio_path != '';`;
  try {
    const { rows: segments } = await pool.query(query, [limit, offset]);
    const { rows: countRows } = await pool.query(countQuery);
    const totalSegments = parseInt(countRows[0].count, 10);
    return {
      segments,
      totalSegments,
      totalPages: Math.ceil(totalSegments / limit),
      currentPage: page,
    };
  } catch (err) {
    console.error('Error fetching paginated segments:', err);
    throw err;
  }
};

export const checkAndCleanupMissingAudioFiles = async (processedDir: string) => {
  const query = `
    SELECT db_id, processed_audio_path
    FROM martyrs
    WHERE is_recorded = TRUE 
    AND processed_audio_path IS NOT NULL 
    AND processed_audio_path != '';
  `;
  
  try {
    const { rows } = await pool.query(query);
    const missingFiles = [];
    
    for (const row of rows) {
      const filePath = path.join(processedDir, row.processed_audio_path);
      if (!fs.existsSync(filePath)) {
        missingFiles.push(row.db_id);
        await markNameAsUnrecorded(row.db_id);
        console.log(`Marked name ${row.db_id} as unrecorded due to missing audio file: ${row.processed_audio_path}`);
      }
    }
    
    return {
      success: true,
      checkedCount: rows.length,
      missingFilesCount: missingFiles.length,
      missingFileIds: missingFiles
    };
  } catch (err) {
    console.error('Error checking for missing audio files:', err);
    return {
      success: false,
      error: err
    };
  }
};

export default pool; 