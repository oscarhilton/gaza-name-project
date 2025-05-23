import { Pool } from 'pg';
import { generatePhoneticPronunciations } from './db';

const BATCH_SIZE = 1000;

async function updatePhonetics() {
  const poolConfig = {
    user: process.env.DB_USER || 'gaza_name_user',
    host: process.env.DB_HOST || 'postgres',
    database: process.env.DB_NAME || 'gaza_name_project_db',
    password: process.env.DB_PASSWORD || 'your_secure_password',
    port: parseInt(process.env.DB_PORT || '5432'),
  };
  console.log('Postgres pool config:', poolConfig);
  const pool = new Pool(poolConfig);

  try {
    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) FROM martyrs');
    const totalRecords = parseInt(countResult.rows[0].count);
    console.log(`Total records to process: ${totalRecords}`);

    let processed = 0;
    let updated = 0;

    // Process records with NULL phonetic data
    while (processed < totalRecords) {
      const result = await pool.query(
        'SELECT db_id, en_name FROM martyrs WHERE phonetic_ipa IS NULL AND phonetic_syllables IS NULL ORDER BY db_id LIMIT $1',
        [BATCH_SIZE]
      );

      if (result.rows.length === 0) break;

      for (const row of result.rows) {
        const { db_id, en_name } = row;
        const { ipa, syllables } = await generatePhoneticPronunciations(en_name);

        await pool.query(
          'UPDATE martyrs SET phonetic_ipa = $1, phonetic_syllables = $2 WHERE db_id = $3',
          [ipa, syllables, db_id]
        );

        updated++;
      }

      processed += result.rows.length;
      console.log(`Processed ${processed}/${totalRecords} records (${updated} updated)`);
    }

    // Process records with existing phonetic data
    const existingResult = await pool.query(
      'SELECT db_id, en_name FROM martyrs WHERE phonetic_ipa IS NOT NULL AND phonetic_syllables IS NOT NULL ORDER BY db_id'
    );

    for (const row of existingResult.rows) {
      const { db_id, en_name } = row;
      const { ipa, syllables } = await generatePhoneticPronunciations(en_name);

      await pool.query(
        'UPDATE martyrs SET phonetic_ipa = $1, phonetic_syllables = $2 WHERE db_id = $3',
        [ipa, syllables, db_id]
      );

      updated++;
    }

    console.log('Finished updating phonetic pronunciations');
  } catch (error) {
    console.error('Error updating phonetic pronunciations:', error);
  } finally {
    await pool.end();
  }
}

// Run the update
updatePhonetics().catch(console.error); 