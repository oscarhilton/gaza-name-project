import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';

const pool = new Pool({
  user: process.env.DB_USER || 'gaza_name_user',
  host: process.env.DB_HOST || 'postgres',
  database: process.env.DB_NAME || 'gaza_name_project_db',
  password: process.env.DB_PASSWORD || 'your_secure_password',
  port: parseInt(process.env.DB_PORT || '5432'),
});

export const connectToDB = async () => {
  let retries = 5;
  while (retries > 0) {
    try {
      await pool.query('SELECT NOW()');
      console.log('Successfully connected to PostgreSQL database.');
      return true;
    } catch (err) {
      console.error(`Error connecting to PostgreSQL database (${retries} retries left):`, err);
      retries--;
      if (retries === 0) {
        throw new Error('Failed to connect to database after multiple attempts');
      }
      // Wait for 5 seconds before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  return false;
};

export const createMartyrsTable = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'martyrs'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.log('Creating martyrs table...');
      const createQuery = `
        CREATE TABLE martyrs (
          db_id SERIAL PRIMARY KEY,
          source_id TEXT,
          name TEXT NOT NULL,
          en_name TEXT NOT NULL,
          dob TEXT,
          age INTEGER,
          sex TEXT CHECK (sex IN ('m', 'f')),
          source_info TEXT,
          is_recorded BOOLEAN DEFAULT FALSE,
          recorded_at TIMESTAMP,
          processed_audio_path TEXT,
          processed_video_path TEXT,
          phonetic_ipa TEXT,
          phonetic_syllables TEXT
        );
      `;
      await client.query(createQuery);
      console.log('Martyrs table created successfully.');
    } else {
      console.log('Martyrs table already exists.');
      
      // Check for duplicates and handle them
      const duplicates = await client.query(`
        SELECT en_name, COUNT(*) as count
        FROM martyrs
        GROUP BY en_name
        HAVING COUNT(*) > 1;
      `);

      if (duplicates.rows.length > 0) {
        console.log(`Found ${duplicates.rows.length} duplicate en_name values. Handling duplicates...`);
        
        // For each duplicate, keep the first record and mark others as duplicates
        for (const dup of duplicates.rows) {
          const { en_name } = dup;
          await client.query(`
            WITH ranked AS (
              SELECT db_id,
                     ROW_NUMBER() OVER (PARTITION BY en_name ORDER BY db_id) as rn
              FROM martyrs
              WHERE en_name = $1
            )
            UPDATE martyrs
            SET en_name = en_name || '_dup_' || martyrs.db_id
            FROM ranked
            WHERE martyrs.db_id = ranked.db_id
            AND ranked.rn > 1;
          `, [en_name]);
        }
        console.log('Duplicates handled successfully.');
      }

      // Now add the unique constraint
      const constraintCheck = await client.query(`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'unique_en_name'
          AND table_name = 'martyrs'
        );
      `);
      
      if (!constraintCheck.rows[0].exists) {
        console.log('Adding unique constraint on en_name...');
        await client.query(`
          ALTER TABLE martyrs
          ADD CONSTRAINT unique_en_name UNIQUE (en_name);
        `);
        console.log('Unique constraint added successfully.');
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating/checking martyrs table:', err);
    throw err;
  } finally {
    client.release();
  }
};

// Initialize database schema
export const initializeDatabase = async () => {
  try {
    await connectToDB();
    await createMartyrsTable();
    console.log('Database initialization completed successfully.');
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
};

export async function insertMartyrs(martyrsData: any[]): Promise<{ insertedCount: number; skippedCount: number }> {
  const client = await pool.connect();
  let insertedCount = 0;
  let skippedCount = 0;

  try {
    await client.query('BEGIN');

    for (const martyr of martyrsData) {
      try {
        // Generate phonetic pronunciations
        const lowercaseName = martyr.en_name.toLowerCase();
        console.log(`Generating phonetic pronunciations for: ${martyr.en_name}`);
        console.log(`Lowercase input: ${lowercaseName}`);
        
        const phoneticData = await generatePhoneticPronunciations(lowercaseName);
        console.log(`Generated phonetic: ${phoneticData.ipa}`);
        console.log(`Generated syllables: ${phoneticData.syllables}`);

        // Insert with ON CONFLICT DO NOTHING
        const result = await client.query(
          `INSERT INTO martyrs (
            source_id, name, en_name, dob, sex, age, source_info, 
            is_recorded, phonetic_ipa, phonetic_syllables
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9)
          ON CONFLICT (en_name) DO NOTHING
          RETURNING db_id`,
          [
            martyr.id,
            martyr.name,
            martyr.en_name,
            martyr.dob,
            martyr.sex,
            martyr.age,
            martyr.source,
            phoneticData.ipa,
            phoneticData.syllables
          ]
        );

        if (result.rowCount && result.rowCount > 0) {
          insertedCount++;
        } else {
          skippedCount++;
        }
      } catch (error: any) {
        // Log validation errors but continue processing
        if (error.name === 'ZodError') {
          console.log(`Validation error for martyr: ${error.message}`);
          skippedCount++;
        } else {
          // For other errors, rollback the transaction
          await client.query('ROLLBACK');
          throw error;
        }
      }
    }

    await client.query('COMMIT');
    console.log(`Inserted ${insertedCount} new martyrs, skipped ${skippedCount} duplicates/invalid records.`);
    return { insertedCount, skippedCount };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error inserting martyrs:', error);
    throw error;
  } finally {
    client.release();
  }
}

export const generatePhoneticPronunciations = async (name: string): Promise<{ ipa: string, syllables: string }> => {
  console.log('Generating phonetic pronunciations for:', name);
  
  // Common English transliteration patterns to simplified phonetics
  const phoneticMap: { [key: string]: string } = {
    // Vowels
    'aa': 'ah',
    'ae': 'ay',
    'ai': 'ay',
    'ay': 'ay',
    'ee': 'ee',
    'ei': 'ay',
    'ey': 'ay',
    'ie': 'ee',
    'oo': 'oo',
    'ou': 'oo',
    'ow': 'ow',
    'a': 'ah',
    'e': 'eh',
    'i': 'ee',
    'o': 'oh',
    'u': 'oo',
    'y': 'ee',  // As a vowel
    
    // Consonants and common clusters
    'th': 'th',
    'kh': 'kh',
    'gh': 'gh',
    'sh': 'sh',
    'dh': 'dh',
    'ch': 'ch',
    'dj': 'j',
    'j': 'j',
    'q': 'k',
    'z': 'z',
    's': 's',
    'h': 'h',
    'r': 'r',
    'l': 'l',
    'm': 'm',
    'n': 'n',
    'b': 'b',
    'd': 'd',
    'f': 'f',
    'g': 'g',
    'k': 'k',
    'p': 'p',
    't': 't',
    'v': 'v',
    'w': 'w'
  };

  // Convert to lowercase for consistent processing
  let input = name.toLowerCase();
  console.log('Lowercase input:', input);
  
  // Sort patterns by length (descending) to prefer longer matches
  const sortedPatterns = Object.entries(phoneticMap)
    .sort((a, b) => b[0].length - a[0].length);
  
  // Generate phonetic pronunciation
  let phonetic = input;
  for (const [pattern, replacement] of sortedPatterns) {
    phonetic = phonetic.replace(new RegExp(pattern, 'g'), replacement);
  }
  console.log('Generated phonetic:', phonetic);

  // Generate syllable breakdown using improved rules
  let syllables = input;
  
  // Add syllable breaks before consonants after vowels
  syllables = syllables.replace(/([aeiou])([^aeiou])/g, '$1-$2');
  
  // Add syllable breaks before vowels after consonants
  syllables = syllables.replace(/([^aeiou])([aeiou])/g, '$1-$2');
  
  // Handle common consonant clusters
  syllables = syllables.replace(/([^aeiou])([^aeiou])([^aeiou])/g, '$1-$2$3');
  
  // Clean up any double hyphens
  syllables = syllables.replace(/-+/g, '-');
  
  // Remove leading/trailing hyphens
  syllables = syllables.replace(/^-|-$/g, '');
  console.log('Generated syllables:', syllables);

  return {
    ipa: phonetic,
    syllables: syllables
  };
};

export const getUnrecordedNames = async (limit: number = 100) => {
  await createMartyrsTable(); 
  const query = `
    SELECT db_id, en_name, name, age, sex, phonetic_ipa, phonetic_syllables
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
    SELECT db_id, en_name, name, age, sex, processed_audio_path, phonetic_ipa, phonetic_syllables
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
  try {
    const { rows } = await pool.query(`
      SELECT db_id, processed_audio_path 
      FROM martyrs 
      WHERE is_recorded = TRUE AND processed_audio_path IS NOT NULL
    `);
    
    const missingFiles: number[] = [];
    for (const row of rows) {
      const fullPath = path.join(processedDir, row.processed_audio_path);
      if (!fs.existsSync(fullPath)) {
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

export const updateExistingRecordsWithPhonetics = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Get all records without phonetic data
    const { rows } = await client.query(`
      SELECT db_id, en_name 
      FROM martyrs 
      WHERE phonetic_ipa IS NULL OR phonetic_syllables IS NULL
    `);
    
    let updatedCount = 0;
    for (const row of rows) {
      const phoneticData = await generatePhoneticPronunciations(row.en_name);
      await client.query(`
        UPDATE martyrs 
        SET phonetic_ipa = $1, phonetic_syllables = $2 
        WHERE db_id = $3
      `, [phoneticData.ipa, phoneticData.syllables, row.db_id]);
      updatedCount++;
    }
    
    await client.query('COMMIT');
    console.log(`Updated ${updatedCount} records with phonetic pronunciations.`);
    return { success: true, updatedCount };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating records with phonetics:', err);
    return { success: false, error: err };
  } finally {
    client.release();
  }
};

export const updateProcessedVideoPath = async (dbId: number, filePath: string) => {
  if (!dbId || !filePath) return { success: false, message: 'Missing ID or path.' };
  const query = `UPDATE martyrs SET processed_video_path = $2 WHERE db_id = $1;`;
  try {
    await pool.query(query, [dbId, filePath]);
    return { success: true, message: 'Updated video path.' };
  } catch (err) {
    console.error(`Error updating video path for ${dbId}:`, err);
    return { success: false, message: 'DB error.', error: err };
  }
};

export const getRecordedVideoPaths = async () => {
  const query = `
    SELECT processed_video_path FROM martyrs 
    WHERE is_recorded = TRUE AND processed_video_path IS NOT NULL AND processed_video_path != ''
    ORDER BY recorded_at;
  `;
  try {
    const { rows } = await pool.query(query);
    return rows.map(row => row.processed_video_path);
  } catch (err) {
    console.error('Error fetching video paths:', err);
    throw err;
  }
};

export const getStats = async () => {
  const { rows } = await pool.query(`
    SELECT 
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE is_recorded) AS recorded,
      COUNT(*) FILTER (WHERE NOT is_recorded) AS unrecorded,
      COUNT(*) FILTER (WHERE processed_audio_path IS NOT NULL) AS processed_audio,
      COUNT(*) FILTER (WHERE processed_video_path IS NOT NULL) AS processed_video
    FROM martyrs;
  `);
  return rows[0];
};

export default pool;